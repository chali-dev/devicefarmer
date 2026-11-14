# Minimal multi-arch ADB server (devicefarmer/adb is amd64-only).
FROM alpine:3.22
RUN apk add --no-cache android-tools
EXPOSE 5037
# -a: listen on all interfaces so STF and the API can reach the server
ENTRYPOINT ["adb", "-a", "-P", "5037", "server", "nodaemon"]
