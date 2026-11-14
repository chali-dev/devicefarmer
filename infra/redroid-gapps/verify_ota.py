"""Verify an Android OTA whole-file signature (signapk -w; as RecoverySystem.verifyPackage):
signed data = file without the 2-byte comment length and the comment; PKCS#7 block is inside
the comment; signer must be the published certificate. Usage: verify_ota.py <zip> <cert.pem>"""
import os, subprocess, sys, tempfile
zpath, pem = sys.argv[1], sys.argv[2]
d = open(zpath, 'rb').read()
footer = d[-6:]
if footer[2:4] != b'\xff\xff':
    sys.exit('no OTA whole-file signature footer')
sig_start = int.from_bytes(footer[0:2], 'little')
comment_size = int.from_bytes(footer[4:6], 'little')
if len(d) < comment_size + 22 or d[-comment_size - 22:-comment_size - 18] != b'PK\x05\x06':
    sys.exit('EOCD does not match comment size')
signed = d[:len(d) - comment_size - 2]
block = d[len(d) - sig_start:len(d) - 6]
tmp = tempfile.mkdtemp()
open(os.path.join(tmp, 'signed'), 'wb').write(signed)
open(os.path.join(tmp, 'sig.p7'), 'wb').write(block)
r = subprocess.run(['openssl', 'cms', '-verify', '-binary', '-inform', 'DER', '-in', f'{tmp}/sig.p7',
                    '-content', f'{tmp}/signed', '-certfile', pem, '-noverify', '-signer', f'{tmp}/signer.pem',
                    '-out', '/dev/null'], capture_output=True, text=True)
if r.returncode != 0:
    sys.exit('signature invalid: ' + r.stderr.strip())
fp = lambda p: subprocess.run(['openssl', 'x509', '-in', p, '-noout', '-fingerprint', '-sha256'], capture_output=True, text=True).stdout.strip()
if fp(f'{tmp}/signer.pem') != fp(pem):
    sys.exit('signer is not the published release certificate')
print(f'VERIFIED whole-file signature ({len(signed)} signed bytes), signer == {os.path.basename(pem)}')
