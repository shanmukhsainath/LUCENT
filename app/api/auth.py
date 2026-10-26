from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session

from app.api.dependencies import get_current_user
from app.core.security import create_access_token, hash_password, verify_password
from app.database.session import get_db
from app.models import User
from app.schemas.auth import AuthResponse, LoginResponse, RegisterRequest, UserResponse, UserUpdateRequest

router = APIRouter(prefix="/api/auth", tags=["authentication"])
DbSession = Annotated[Session, Depends(get_db)]
CurrentUser = Annotated[User, Depends(get_current_user)]

DATABASE_UNAVAILABLE = (
    "Cannot reach the database. Check DATABASE_URL in your .env and confirm the "
    "Supabase project is reachable, then run 'alembic upgrade head'."
)


def reachable_database(db: Session) -> None:
    """Turn a connection failure into a readable 503 instead of an opaque 500."""
    try:
        db.execute(select(func.now()))
    except SQLAlchemyError as error:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=DATABASE_UNAVAILABLE,
        ) from error


@router.post("/register", response_model=AuthResponse, status_code=status.HTTP_201_CREATED)
def register(payload: RegisterRequest, db: DbSession) -> AuthResponse:
    reachable_database(db)
    normalized_email = payload.email.lower()
    existing_user = db.scalar(select(User).where(func.lower(User.email) == normalized_email))
    if existing_user:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="An account with this email already exists")

    user = User(
        name=payload.name.strip(),
        display_name=payload.name.strip(),
        email=normalized_email,
        password_hash=hash_password(payload.password),
        preferred_language=payload.preferred_language,
    )
    db.add(user)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="An account with this email already exists") from None
    db.refresh(user)
    return AuthResponse(access_token=create_access_token(user.id), user=UserResponse.model_validate(user))


@router.post("/login", response_model=LoginResponse)
def login(form_data: Annotated[OAuth2PasswordRequestForm, Depends()], db: DbSession) -> LoginResponse:
    reachable_database(db)
    normalized_email = form_data.username.lower()
    user = db.scalar(select(User).where(func.lower(User.email) == normalized_email))
    if user is None or not verify_password(form_data.password, user.password_hash) or not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect email or password",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return LoginResponse(access_token=create_access_token(user.id), user=UserResponse.model_validate(user))


@router.get("/me", response_model=UserResponse)
def get_me(current_user: CurrentUser) -> UserResponse:
    return UserResponse.model_validate(current_user)


@router.patch("/me", response_model=UserResponse)
def update_me(payload: UserUpdateRequest, current_user: CurrentUser, db: DbSession) -> UserResponse:
    changes = payload.model_dump(exclude_unset=True)
    if "name" in changes:
        current_user.name = changes["name"].strip()
        current_user.display_name = current_user.name
    if "preferred_language" in changes:
        current_user.preferred_language = changes["preferred_language"].strip().lower()
    if "timezone" in changes:
        current_user.timezone = changes["timezone"].strip()
    db.commit()
    db.refresh(current_user)
    return UserResponse.model_validate(current_user)
