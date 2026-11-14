"""Verify a signed zip (JAR v1 signature): CERT.RSA signs CERT.SF with the expected cert,
CERT.SF covers MANIFEST.MF, MANIFEST.MF covers every file. Usage: verify_jar.py <zip> <cert.pem>"""
import base64, hashlib, subprocess, sys, tempfile, zipfile, os
zpath, pem = sys.argv[1], sys.argv[2]
z = zipfile.ZipFile(zpath)
tmp = tempfile.mkdtemp()
for n in ("META-INF/CERT.SF", "META-INF/CERT.RSA"):
    open(os.path.join(tmp, n.split("/")[-1]), "wb").write(z.read(n))
# 1. PKCS7 signature over CERT.SF, signer must be exactly the published cert
r = subprocess.run(["openssl", "cms", "-verify", "-binary", "-inform", "DER", "-in", f"{tmp}/CERT.RSA",
                    "-content", f"{tmp}/CERT.SF", "-certfile", pem, "-noverify", "-signer", f"{tmp}/signer.pem",
                    "-out", "/dev/null"], capture_output=True, text=True)
assert r.returncode == 0, "CMS signature invalid: " + r.stderr
fp = lambda p: subprocess.run(["openssl", "x509", "-in", p, "-noout", "-fingerprint", "-sha256"], capture_output=True, text=True).stdout.strip()
assert fp(f"{tmp}/signer.pem") == fp(pem), "signer is not the published release certificate"
print("1. CERT.RSA signature over CERT.SF valid; signer == release.x509.pem")
def sections(text):
    out, cur = [], ""
    for line in text.split("\r\n"):
        if line == "" and cur: out.append(cur); cur = ""
        elif line: cur += line + "\r\n"
    if cur: out.append(cur)
    return out
def attrs(sec):
    d, key = {}, None
    for line in sec.split("\r\n"):
        if line.startswith(" ") and key: d[key] += line[1:]
        elif ": " in line: key, v = line.split(": ", 1); d[key] = v
    return d
mf = z.read("META-INF/MANIFEST.MF").decode()
sf = z.read("META-INF/CERT.SF").decode()
sf_main = attrs(sections(sf)[0])
alg = [k for k in sf_main if k.endswith("-Digest-Manifest")][0].replace("-Digest-Manifest", "")
h = {"SHA-256": hashlib.sha256, "SHA1": hashlib.sha1}[alg]
assert base64.b64encode(h(mf.encode()).digest()).decode() == sf_main[alg + "-Digest-Manifest"], "MANIFEST digest mismatch"
print(f"2. CERT.SF {alg} digest of MANIFEST.MF matches")
entries = {attrs(s)["Name"]: attrs(s) for s in sections(mf)[1:]}
files = [n for n in z.namelist() if not n.endswith("/") and not n.startswith("META-INF/CERT") and n != "META-INF/MANIFEST.MF"]
bad = [n for n in files if n not in entries or base64.b64encode(h(z.read(n)).digest()).decode() != entries[n][alg + "-Digest"]]
assert not bad, f"unsigned or modified files: {bad}"
print(f"3. all {len(files)} files match MANIFEST.MF digests")
print("VERIFIED")
