import android.net.LocalSocket;
import android.net.LocalSocketAddress;

import java.io.BufferedInputStream;
import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.ArrayDeque;
import java.util.Base64;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;

import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;

/**
 * CpRelay: carries a device's local scrcpy-server sockets to the API over WebSockets, outside adb
 * (adb without delayed_ack moves ~100 KB/s per stream over a 0.3 s link; plain TCP is not limited so).
 *
 * Usage (as shell, via app_process): CpRelay <abstract socket name> <channels, e.g. video,control> <ws(s) url> <token>
 * For each channel in order: open the WebSocket (header X-Relay-Token, query ch=<channel>), then connect
 * the local abstract socket (retried until the server listens), then pump both ways. The order matters:
 * scrcpy-server takes its first accepted socket as video, the second as control.
 * Any end (EOF, error, close frame) exits the process; the API sees its WebSocket close and tears down.
 *
 * Timed control (both sides send the header X-Relay-Timed: 1; otherwise raw bytes as before, so an older
 * API or helper still works): API → device data on the control channel is framed as [u32 len][u16 dt][payload].
 * A remote link delivers touch moves in clumps and scrcpy-server stamps each event with its injection time,
 * so Android would see a clump as one instant (absurd fling velocity). Here each timed message (dt = ms
 * after the previous timed one, in the browser's clock) is written at max(arrival, previous + dt), never
 * more than MAX_LAG_MS after its arrival: the device sees the finger's real spacing (late ones go at once,
 * nothing is reordered). dt = 0xFFFF = untimed (keys, clipboard): written as soon as its turn comes.
 * A touch DOWN waits for the gesture's next message (at most DOWN_WAIT_MS) and is placed dt before it: the
 * link often delivers the DOWN alone and the moves a clump later, and that gap would look like a long press.
 */
public final class CpRelay {
  private static final int CHUNK = 16 * 1024; // below the API's WebSocket max payload
  private static final int UNTIMED = 0xFFFF;
  private static final long MAX_LAG_MS = 1000;
  private static final long DOWN_WAIT_MS = 300;
  private static final long MS = 1_000_000L;

  public static void main(String[] a) throws Exception {
    if (a.length != 4) { System.err.println("usage: CpRelay <socket> <ch1,ch2> <ws-url> <token>"); System.exit(2); }
    URI url = new URI(a[2]);
    for (String ch : a[1].split(",")) {
      try {
        Ws ws = Ws.open(url, ch, a[3]);
        LocalSocket local = connectLocal(a[0], 10_000);
        pump(local, ws, ch);
      } catch (Exception e) {
        die(ch + ": " + e); // stdout: the API keeps the last lines for its error message
      }
      System.out.println("relay " + ch + " up");
    }
    Thread.currentThread().join(); // the pump threads exit the process
  }

  private static LocalSocket connectLocal(String name, long timeoutMs) throws Exception {
    long deadline = System.currentTimeMillis() + timeoutMs;
    for (;;) {
      LocalSocket s = new LocalSocket();
      try {
        s.connect(new LocalSocketAddress(name, LocalSocketAddress.Namespace.ABSTRACT));
        return s;
      } catch (IOException e) {
        s.close();
        if (System.currentTimeMillis() > deadline) throw e;
        Thread.sleep(100);
      }
    }
  }

  private static void pump(LocalSocket local, final Ws ws, final String ch) throws IOException {
    final InputStream lin = local.getInputStream();
    final OutputStream lout = local.getOutputStream();
    Thread up = new Thread(new Runnable() {
      @Override public void run() {
        byte[] buf = new byte[CHUNK];
        try {
          for (int n; (n = lin.read(buf)) > 0; ) ws.sendBinary(buf, n);
          die(ch + ": local socket ended");
        } catch (Exception e) { die(ch + ": local read: " + e); }
      }
    });
    Thread down = new Thread(new Runnable() {
      @Override public void run() {
        try {
          if (ws.timed) readTimed(ws, lout, ch);
          else for (;;) { byte[] m = ws.readData(); if (m.length > 0) lout.write(m); }
        } catch (Exception e) { die(ch + ": websocket: " + e); }
      }
    });
    up.start();
    down.start();
  }

  /** One framed control message with its arrival time (System.nanoTime). */
  private static final class Timed {
    final long at; final int dt; final byte[] data;
    Timed(long at, int dt, byte[] data) { this.at = at; this.dt = dt; this.data = data; }
  }

  /** scrcpy INJECT_TOUCH_EVENT (type 2) with ACTION_DOWN (0). */
  private static boolean isTouchDown(byte[] m) {
    return m.length > 1 && m[0] == 2 && m[1] == 0;
  }

  /** Splits the framed stream (frames may span or share WebSocket messages) and hands them to a pacing writer. */
  private static void readTimed(Ws ws, final OutputStream lout, final String ch) throws Exception {
    final LinkedBlockingQueue<Timed> q = new LinkedBlockingQueue<Timed>();
    Thread writer = new Thread(new Runnable() {
      @Override public void run() {
        long prev = Long.MIN_VALUE / 2; // target time of the previous timed message
        ArrayDeque<Timed> taken = new ArrayDeque<Timed>(); // read ahead while a DOWN waited, still in order
        try {
          for (;;) {
            Timed t = taken.isEmpty() ? q.take() : taken.removeFirst();
            if (t.dt != UNTIMED) {
              long at = t.at;
              if (isTouchDown(t.data) && taken.isEmpty()) {
                // wait for the next timed message (untimed ones, e.g. clipboard polls, are kept behind the DOWN)
                long deadline = t.at + DOWN_WAIT_MS * MS;
                Timed n;
                while ((n = q.poll(Math.max(0, deadline - System.nanoTime()), TimeUnit.NANOSECONDS)) != null) {
                  taken.addLast(n);
                  if (n.dt != UNTIMED) break;
                }
                at = n == null ? deadline : Math.max(t.at, n.at - n.dt * MS);
              }
              long target = Math.max(at, Math.min(prev + t.dt * MS, at + MAX_LAG_MS * MS));
              long wait = target - System.nanoTime();
              if (wait > 0) Thread.sleep(wait / MS, (int) (wait % MS));
              prev = target;
            }
            lout.write(t.data);
          }
        } catch (Exception e) { die(ch + ": local write: " + e); }
      }
    });
    writer.start();
    byte[] buf = new byte[0];
    for (;;) {
      byte[] m = ws.readData();
      long at = System.nanoTime();
      byte[] all = new byte[buf.length + m.length];
      System.arraycopy(buf, 0, all, 0, buf.length);
      System.arraycopy(m, 0, all, buf.length, m.length);
      int off = 0;
      while (all.length - off >= 6) {
        int len = ((all[off] & 0xff) << 24) | ((all[off + 1] & 0xff) << 16) | ((all[off + 2] & 0xff) << 8) | (all[off + 3] & 0xff);
        if (len < 0 || len > 16 * 1024 * 1024) throw new IOException("bad frame length " + len);
        if (all.length - off - 6 < len) break;
        int dt = ((all[off + 4] & 0xff) << 8) | (all[off + 5] & 0xff);
        byte[] data = new byte[len];
        System.arraycopy(all, off + 6, data, 0, len);
        q.put(new Timed(at, dt, data));
        off += 6 + len;
      }
      buf = new byte[all.length - off];
      System.arraycopy(all, off, buf, 0, buf.length);
    }
  }

  private static void die(String why) {
    System.out.println("relay end: " + why);
    System.exit(0);
  }

  /** Minimal RFC 6455 client: binary frames out (masked), data frames in, ping answered, close ends. */
  static final class Ws {
    private final InputStream in;
    private final OutputStream out;
    private final SecureRandom rnd = new SecureRandom();
    /** The API agreed to timed control framing (response header X-Relay-Timed: 1). */
    boolean timed;

    private Ws(Socket s) throws IOException {
      in = new BufferedInputStream(s.getInputStream(), 64 * 1024);
      out = s.getOutputStream();
    }

    static Ws open(URI u, String ch, String token) throws Exception {
      boolean tls = "wss".equals(u.getScheme());
      String host = u.getHost();
      int port = u.getPort() > 0 ? u.getPort() : tls ? 443 : 80;
      Socket raw = new Socket();
      raw.connect(new InetSocketAddress(host, port), 10_000);
      raw.setTcpNoDelay(true);
      Socket s = raw;
      if (tls) {
        SSLSocket ss = (SSLSocket) ((SSLSocketFactory) SSLSocketFactory.getDefault()).createSocket(raw, host, port, true); // host → SNI
        ss.startHandshake();
        if (!HttpsURLConnection.getDefaultHostnameVerifier().verify(host, ss.getSession())) throw new IOException("TLS hostname mismatch");
        s = ss;
      }
      Ws ws = new Ws(s);
      byte[] k = new byte[16];
      ws.rnd.nextBytes(k);
      String key = Base64.getEncoder().encodeToString(k);
      String path = (u.getRawPath() == null || u.getRawPath().isEmpty() ? "/" : u.getRawPath())
          + (u.getRawQuery() == null ? "?" : "?" + u.getRawQuery() + "&") + "ch=" + ch;
      String req = "GET " + path + " HTTP/1.1\r\nHost: " + host + (u.getPort() > 0 ? ":" + port : "") + "\r\n"
          + "Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\n"
          + "Sec-WebSocket-Key: " + key + "\r\nX-Relay-Token: " + token + "\r\nX-Relay-Timed: 1\r\nUser-Agent: CpRelay\r\n\r\n";
      ws.out.write(req.getBytes(StandardCharsets.US_ASCII));
      ws.out.flush();
      String status = ws.line();
      if (!status.startsWith("HTTP/1.1 101")) throw new IOException("handshake: " + status);
      String expect = Base64.getEncoder().encodeToString(MessageDigest.getInstance("SHA-1")
          .digest((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").getBytes(StandardCharsets.US_ASCII)));
      boolean accepted = false;
      for (String l; !(l = ws.line()).isEmpty(); ) {
        int i = l.indexOf(':');
        if (i <= 0) continue;
        String name = l.substring(0, i).trim(), value = l.substring(i + 1).trim();
        if (name.equalsIgnoreCase("Sec-WebSocket-Accept") && value.equals(expect)) accepted = true;
        if (name.equalsIgnoreCase("X-Relay-Timed") && value.equals("1")) ws.timed = true;
      }
      if (!accepted) throw new IOException("handshake: bad Sec-WebSocket-Accept");
      return ws;
    }

    private String line() throws IOException {
      StringBuilder sb = new StringBuilder();
      for (int c; (c = in.read()) != '\n'; ) { if (c < 0) throw new EOFException(); if (c != '\r') sb.append((char) c); }
      return sb.toString();
    }

    void sendBinary(byte[] b, int len) throws IOException { send(0x2, b, len); }

    private synchronized void send(int opcode, byte[] b, int len) throws IOException {
      int hl = len < 126 ? 2 : len < 65536 ? 4 : 10;
      byte[] f = new byte[hl + 4 + len];
      f[0] = (byte) (0x80 | opcode);
      if (len < 126) f[1] = (byte) (0x80 | len);
      else if (len < 65536) { f[1] = (byte) (0x80 | 126); f[2] = (byte) (len >> 8); f[3] = (byte) len; }
      else { f[1] = (byte) (0x80 | 127); for (int i = 0; i < 8; i++) f[2 + i] = (byte) ((long) len >> (56 - 8 * i)); }
      byte[] mask = new byte[4];
      rnd.nextBytes(mask);
      System.arraycopy(mask, 0, f, hl, 4);
      for (int i = 0; i < len; i++) f[hl + 4 + i] = (byte) (b[i] ^ mask[i & 3]);
      out.write(f);
      out.flush();
    }

    /** Payload of the next data frame (binary/text/continuation); answers pings; throws on close/EOF. */
    byte[] readData() throws IOException {
      for (;;) {
        int b0 = read(), b1 = read();
        int op = b0 & 0x0f;
        long len = b1 & 0x7f;
        if (len == 126) len = (read() << 8) | read();
        else if (len == 127) { len = 0; for (int i = 0; i < 8; i++) len = (len << 8) | read(); }
        if (len > 16 * 1024 * 1024) throw new IOException("frame too large");
        byte[] mask = (b1 & 0x80) != 0 ? new byte[] { (byte) read(), (byte) read(), (byte) read(), (byte) read() } : null;
        byte[] p = new byte[(int) len];
        for (int off = 0; off < p.length; ) { int n = in.read(p, off, p.length - off); if (n < 0) throw new EOFException(); off += n; }
        if (mask != null) for (int i = 0; i < p.length; i++) p[i] ^= mask[i & 3];
        if (op == 0x8) throw new EOFException("close frame");
        if (op == 0x9) { send(0xA, p, p.length); continue; }
        if (op == 0xA) continue;
        return p;
      }
    }

    private int read() throws IOException {
      int c = in.read();
      if (c < 0) throw new EOFException();
      return c;
    }
  }
}
