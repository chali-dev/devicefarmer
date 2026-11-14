"""Stage MindTheGapps system/ tree for a Docker overlay, mirroring the official
update-binary: dirs 0755, files 0644, plus its own optional removal list."""
import os, shutil, sys, zipfile
zpath, out = sys.argv[1], sys.argv[2]
REMOVE = ("system/product/priv-app/Velvet/", "system/product/priv-app/VelvetTitan/",
          "system/system_ext/priv-app/SetupWizard/", "system/product/app/talkback/",
          "system/product/app/MarkupGoogle/", "system/addon.d/")
shutil.rmtree(os.path.join(out, "system"), ignore_errors=True)
z = zipfile.ZipFile(zpath)
kept = 0
for n in z.namelist():
    if not n.startswith("system/") or n.endswith("/") or n.startswith(REMOVE):
        continue
    dest = os.path.join(out, n)
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    with open(dest, "wb") as f:
        f.write(z.read(n))
    os.chmod(dest, 0o644)
    kept += 1
for root, dirs, _ in os.walk(out):
    for d in dirs:
        os.chmod(os.path.join(root, d), 0o755)
os.chmod(out, 0o755)
print("staged files:", kept)
