"""locserver - self-hosted markerless visual localisation for an AR-to-VR portal."""

__version__ = "0.4.0"

# Identity reported by GET /health. The mobile app accepts a host only if `service`
# matches, and uses `api_version` to detect an incompatible server.
SERVICE_ID = "arportal-localization-server"
API_VERSION = 1  # bump only on breaking API changes
