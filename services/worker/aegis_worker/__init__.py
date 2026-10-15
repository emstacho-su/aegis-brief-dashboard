"""AEGIS daily brief worker.

Validates brief JSON against the shared schema, derives the archive index, renders a
deterministic static HTML page per brief, maintains the rotating volume, optionally
mirrors to Supabase, and serves the dashboard plus a small JSON API.
"""

__version__ = "1.0.0"
