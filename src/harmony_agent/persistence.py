"""Bounded retries for publishing an already-written local file, never UI actions."""
import os
import time


def atomic_replace(source, destination):
    """Windows readers/indexers can briefly deny replacement of a closed file."""
    delays = (0.01, 0.02, 0.04, 0.08, 0.10)
    for attempt in range(len(delays) + 1):
        try:
            os.replace(source, destination)
            return
        except OSError as exc:
            if getattr(exc, "winerror", None) not in {5, 32, 33} or attempt == len(delays):
                raise
            time.sleep(delays[attempt])
