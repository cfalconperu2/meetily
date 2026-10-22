import hmac

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from .config import API_KEY

_bearer = HTTPBearer(auto_error=False)


def require_api_key(credentials: HTTPAuthorizationCredentials | None = Depends(_bearer)) -> None:
    if not API_KEY:
        # Fail closed: refuse every request rather than silently running open
        # when the operator forgot to set PROCESSOR_API_KEY.
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Server is missing PROCESSOR_API_KEY")
    if credentials is None or not hmac.compare_digest(credentials.credentials, API_KEY):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid or missing bearer token")
