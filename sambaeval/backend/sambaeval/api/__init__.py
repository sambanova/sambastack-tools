"""FastAPI backend for SambaEval — serves the /api/... routes the web UI uses.

Built on the core engine (storage + executor).
"""

from .main import app, serve

__all__ = ["app", "serve"]