class UserError(Exception):
    """사용자에게 그대로 보여줄 수 있는 업무 규칙 오류. 입력은 유지된다."""

    def __init__(self, message: str, *, code: str = "invalid", details: list | None = None):
        super().__init__(message)
        self.message = message
        self.code = code
        self.details = details or []


class ConflictError(UserError):
    """다른 창/시점에서 이미 바뀐 기록을 덮어쓰려 할 때."""

    def __init__(self, message: str = "이 기록은 다른 곳에서 먼저 수정되었습니다. 최신 내용을 불러온 뒤 다시 저장하세요."):
        super().__init__(message, code="conflict")
