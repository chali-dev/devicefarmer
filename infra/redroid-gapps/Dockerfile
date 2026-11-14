# Template: build.sh substitutes the FROM image and the MindTheGapps release name.
# Official redroid + official MindTheGapps (signature verified). Only adds the GApps
# system/ tree; no SELinux, fingerprint or integrity changes.
FROM redroid/redroid:13.0.0_64only-latest
COPY system/ /system/
LABEL org.cloudphone.gapps="MindTheGapps-13.0.0-arm64-20231025_200931"
