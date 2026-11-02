"""Stable error envelope shared by adapters, core, and CLI."""

class AgentError(Exception):
    def __init__(self, code, message, *, details=None, dispatched="no", exit_code=1):
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details or {}
        self.dispatched = dispatched
        self.exit_code = exit_code

    def to_dict(self):
        return {"code": self.code, "message": self.message,
                "details": {**self.details, "dispatched": self.dispatched}}
