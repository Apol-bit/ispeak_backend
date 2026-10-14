#!/bin/sh
set -eu
node /app/docker/validateConfiguration.js
exec "$@"
