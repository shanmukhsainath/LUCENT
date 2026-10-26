"""Static file server for the MeetMind frontend.

The pages in register/, login/, dashboard/ and meetings/ are plain files and are
normally opened with an IDE live server. This script is an equivalent built-in
alternative so the project can be run with nothing but the virtualenv:

    .\\.venv\\Scripts\\python serve_frontend.py

Serve over HTTP rather than opening the files directly, because a page loaded
from file:// sends "Origin: null", which the API's CORS policy rejects.

Any path containing a dot-prefixed segment (".env", ".git", ".venv") is refused
so database credentials and the JWT signing secret are never served.
"""

from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

HOST = "127.0.0.1"
PORT = 5500
ROOT = "."


class FrontendHandler(SimpleHTTPRequestHandler):
    """Static handler that hides dotfiles and serves the project root."""

    def send_head(self):
        path = self.path.split("?", 1)[0].split("#", 1)[0]
        if any(segment.startswith(".") for segment in path.split("/") if segment):
            self.send_error(404, "Not Found")
            return None
        return super().send_head()

    def log_message(self, format_string, *args):
        print(f"{self.address_string()} - {format_string % args}", flush=True)


def main() -> None:
    handler = partial(FrontendHandler, directory=ROOT)
    with ThreadingHTTPServer((HOST, PORT), handler) as server:
        print(f"Frontend serving on http://{HOST}:{PORT}", flush=True)
        print(f"  Sign up : http://{HOST}:{PORT}/register/index.html", flush=True)
        print(f"  Sign in : http://{HOST}:{PORT}/login/index.html", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            print("\nFrontend server stopped.", flush=True)


if __name__ == "__main__":
    main()
