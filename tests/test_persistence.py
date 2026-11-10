"""Local publication tolerates transient Windows access errors without action replay."""
import errno
import unittest
from unittest.mock import patch

from harmony_agent.persistence import atomic_replace


class PersistenceTests(unittest.TestCase):
    def windows_error(self):
        error = PermissionError(errno.EACCES, "synthetic transient reader")
        error.winerror = 5
        return error

    def test_retry_only_same_prepared_file(self):
        with patch("harmony_agent.persistence.os.replace", side_effect=[self.windows_error(), None]) as replace, \
                patch("harmony_agent.persistence.time.sleep") as sleep:
            atomic_replace("prepared", "record")
        self.assertEqual(replace.call_count, 2)
        self.assertTrue(all(call.args == ("prepared", "record") for call in replace.call_args_list))
        sleep.assert_called_once_with(0.01)

    def test_persistent_windows_denial_is_bounded(self):
        with patch("harmony_agent.persistence.os.replace", side_effect=self.windows_error()) as replace, \
                patch("harmony_agent.persistence.time.sleep") as sleep:
            with self.assertRaises(PermissionError):
                atomic_replace("prepared", "record")
        self.assertEqual(replace.call_count, 6)
        self.assertAlmostEqual(sum(call.args[0] for call in sleep.call_args_list), 0.25)

    def test_unrelated_io_failure_is_not_retried(self):
        with patch("harmony_agent.persistence.os.replace", side_effect=OSError(errno.ENOSPC, "full")) as replace, \
                patch("harmony_agent.persistence.time.sleep") as sleep:
            with self.assertRaises(OSError):
                atomic_replace("prepared", "record")
        replace.assert_called_once()
        sleep.assert_not_called()
