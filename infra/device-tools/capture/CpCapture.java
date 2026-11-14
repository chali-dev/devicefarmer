import android.graphics.Bitmap;
import android.graphics.ColorSpace;
import android.hardware.HardwareBuffer;
import android.net.LocalServerSocket;
import android.net.LocalSocket;
import android.os.IBinder;
import android.os.SystemClock;

import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.DataOutputStream;
import java.lang.reflect.Method;

/**
 * Cloud-phone screen capture that includes FLAG_SECURE windows (e.g. Google sign-in),
 * for the device owner's own remote view. Runs via app_process as the system user
 * (redroid userdebug: `su 1000`), which SurfaceFlinger allows to request secure layers.
 *
 * Protocol on abstract socket @<name>: repeated [int32 big-endian length][JPEG bytes].
 * Usage: app_process / CpCapture <socketName> [maxFps] [jpegQuality]   |   CpCapture probe
 *
 * Hidden APIs are resolved by reflection:
 *   Android 13:  SurfaceControl.captureDisplay(SurfaceControl.DisplayCaptureArgs)
 *   Android 14+: android.window.ScreenCapture.captureDisplay(ScreenCapture.DisplayCaptureArgs)
 */
public final class CpCapture {
    private static Method captureMethod;
    private static Object captureArgs;

    private static IBinder displayToken() throws Exception {
        Class<?> sc = Class.forName("android.view.SurfaceControl");
        try { // up to Android 13
            return (IBinder) sc.getMethod("getInternalDisplayToken").invoke(null);
        } catch (NoSuchMethodException ignored) { }
        // Android 14+: DisplayControl lives in services.jar
        long[] ids;
        Class<?> dc;
        try {
            dc = Class.forName("com.android.server.display.DisplayControl");
        } catch (ClassNotFoundException e) {
            ClassLoader cl = (ClassLoader) Class.forName("dalvik.system.PathClassLoader")
                .getConstructor(String.class, ClassLoader.class)
                .newInstance("/system/framework/services.jar", ClassLoader.getSystemClassLoader());
            dc = Class.forName("com.android.server.display.DisplayControl", true, cl);
            // DisplayControl's native methods are registered by libandroid_servers
            Method load = Runtime.class.getDeclaredMethod("loadLibrary0", Class.class, String.class);
            load.setAccessible(true);
            load.invoke(Runtime.getRuntime(), dc, "android_servers");
        }
        ids = (long[]) dc.getMethod("getPhysicalDisplayIds").invoke(null);
        return (IBinder) dc.getMethod("getPhysicalDisplayToken", long.class).invoke(null, ids[0]);
    }

    private static void prepare(int width, int height) throws Exception {
        IBinder token = displayToken();
        Class<?> holder;
        try {
            holder = Class.forName("android.window.ScreenCapture"); // Android 14+
        } catch (ClassNotFoundException e) {
            holder = Class.forName("android.view.SurfaceControl"); // Android 13
        }
        Class<?> builderCls = Class.forName(holder.getName() + "$DisplayCaptureArgs$Builder");
        Object b = builderCls.getConstructor(IBinder.class).newInstance(token);
        b = invokeFluent(b, "setCaptureSecureLayers", boolean.class, true);
        if (width > 0 && height > 0) b = invokeFluent2(b, "setSize", width, height);
        captureArgs = builderCls.getMethod("build").invoke(b);
        captureMethod = holder.getMethod("captureDisplay", captureArgs.getClass());
    }

    private static Object invokeFluent(Object b, String name, Class<?> type, Object v) throws Exception {
        for (Class<?> c = b.getClass(); c != null; c = c.getSuperclass()) {
            try { return c.getMethod(name, type).invoke(b, v); } catch (NoSuchMethodException ignored) { }
        }
        throw new NoSuchMethodException(name);
    }

    private static Object invokeFluent2(Object b, String name, int a, int c2) throws Exception {
        for (Class<?> c = b.getClass(); c != null; c = c.getSuperclass()) {
            try { return c.getMethod(name, int.class, int.class).invoke(b, a, c2); } catch (NoSuchMethodException ignored) { }
        }
        return b; // optional
    }

    private static Bitmap captureBitmap() throws Exception {
        Object shot = captureMethod.invoke(null, captureArgs);
        if (shot == null) throw new IllegalStateException("captureDisplay returned null");
        HardwareBuffer hb = (HardwareBuffer) shot.getClass().getMethod("getHardwareBuffer").invoke(shot);
        ColorSpace cs = ColorSpace.get(ColorSpace.Named.SRGB);
        Bitmap hw = Bitmap.wrapHardwareBuffer(hb, cs);
        if (hw == null) throw new IllegalStateException("wrapHardwareBuffer failed");
        Bitmap sw = hw.copy(Bitmap.Config.ARGB_8888, false); // JPEG encoding needs a software bitmap
        hw.recycle();
        hb.close();
        return sw;
    }

    public static void main(String[] args) throws Exception {
        if (args.length > 0 && "probe".equals(args[0])) {
            prepare(0, 0);
            Bitmap bm = captureBitmap();
            System.out.println("OK " + captureMethod.getDeclaringClass().getName() + " " + bm.getWidth() + "x" + bm.getHeight());
            return;
        }
        String name = args.length > 0 ? args[0] : "cloudphone-capture";
        int maxFps = args.length > 1 ? Integer.parseInt(args[1]) : 10;
        int quality = args.length > 2 ? Integer.parseInt(args[2]) : 70;
        prepare(0, 0);
        LocalServerSocket server = new LocalServerSocket(name);
        System.out.println("listening @" + name);
        while (true) {
            LocalSocket s = server.accept(); // one viewer at a time; the API fans out
            try {
                serve(s, maxFps, quality);
            } catch (Exception e) {
                // client went away
            } finally {
                try { s.close(); } catch (Exception ignored) { }
            }
        }
    }

    private static void serve(LocalSocket s, int maxFps, int quality) throws Exception {
        DataOutputStream out = new DataOutputStream(new BufferedOutputStream(s.getOutputStream(), 1 << 16));
        ByteArrayOutputStream jpeg = new ByteArrayOutputStream(512 * 1024);
        long frameMs = 1000L / Math.max(1, maxFps);
        while (true) {
            long t0 = SystemClock.uptimeMillis();
            Bitmap bm = captureBitmap();
            jpeg.reset();
            bm.compress(Bitmap.CompressFormat.JPEG, quality, jpeg);
            bm.recycle();
            out.writeInt(jpeg.size());
            jpeg.writeTo(out);
            out.flush();
            long left = frameMs - (SystemClock.uptimeMillis() - t0);
            if (left > 0) Thread.sleep(left);
        }
    }
}
