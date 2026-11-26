"""Normalisation for Exercise, Routine, and Day names (spec §3)."""


def normalise(raw: str) -> str:
    """Trim and collapse internal whitespace to one space. Comparison is case-insensitive,
    done by the database on lower(name) so the unique index and the API agree."""
    return " ".join(raw.split())
