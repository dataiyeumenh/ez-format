from pathlib import Path

import pytest

from app.student_workflow import assert_student_anonymization_config


ROOT = Path(__file__).resolve().parents[2]
VALID_STUDENT_SECRET = "Stu_4zN8qR2mV7xK5pT9wY1aD6fH3jL0cBs"
VALID_CONTEXT_SECRET = "Ctx_8mQ2vN7xK4pR9sT1wY6zA3dF5gH0jLc"
VALID_SERVICE_TOKEN = "Svc_7nP3xR8kV2mQ9tW4yZ6aB1dF5hJ0cLs"


def configure_enabled_production(monkeypatch, secret=VALID_STUDENT_SECRET):
    monkeypatch.setenv("NODE_ENV", "production")
    monkeypatch.setenv("STUDENT_ASSISTANT_ENABLED", "true")
    monkeypatch.setenv("STUDENT_ANONYMIZATION_SECRET", secret)
    monkeypatch.setenv("CONVERSION_CONTEXT_SECRET", VALID_CONTEXT_SECRET)
    monkeypatch.setenv("CONVERTER_SERVICE_TOKEN", VALID_SERVICE_TOKEN)


def test_disabled_student_assistant_does_not_require_anonymization_secret(monkeypatch):
    monkeypatch.setenv("NODE_ENV", "production")
    monkeypatch.setenv("STUDENT_ASSISTANT_ENABLED", "false")
    monkeypatch.delenv("STUDENT_ANONYMIZATION_SECRET", raising=False)

    assert_student_anonymization_config()


def test_enabled_production_accepts_high_entropy_distinct_anonymization_secret(
    monkeypatch,
):
    configure_enabled_production(monkeypatch)

    assert_student_anonymization_config()


@pytest.mark.parametrize(
    "secret",
    [
        "replace-with-a-distinct-random-secret-of-at-least-32-characters",
        "<private-distinct-secret-at-least-32-characters>",
        "default-student-anonymization-secret-value",
        "your-student-anonymization-secret-value-123",
        "dev_change_me_in_production_student_secret_123",
        "x" * 64,
        "abc123" * 12,
    ],
)
def test_enabled_production_rejects_unsafe_anonymization_secrets(
    monkeypatch,
    secret,
):
    configure_enabled_production(monkeypatch, secret)

    with pytest.raises(ValueError, match="STUDENT_ANONYMIZATION_SECRET"):
        assert_student_anonymization_config()


@pytest.mark.parametrize(
    ("forbidden_name", "forbidden_value"),
    [
        ("CONVERSION_CONTEXT_SECRET", VALID_CONTEXT_SECRET),
        ("CONVERTER_SERVICE_TOKEN", VALID_SERVICE_TOKEN),
    ],
)
def test_enabled_production_requires_distinct_anonymization_secret(
    monkeypatch,
    forbidden_name,
    forbidden_value,
):
    configure_enabled_production(monkeypatch)
    monkeypatch.setenv("STUDENT_ANONYMIZATION_SECRET", forbidden_value)

    with pytest.raises(ValueError, match=f"must differ from {forbidden_name}"):
        assert_student_anonymization_config()


def test_anonymization_secret_constraints_are_documented():
    for path in (ROOT / ".env.example", ROOT / "converter" / ".env.example"):
        documented_env = path.read_text(encoding="utf-8")
        assert "STUDENT_ANONYMIZATION_SECRET=" in documented_env
        assert "at least 32 characters" in documented_env
        assert "at least 12 distinct characters" in documented_env
        assert "placeholders/defaults are rejected" in documented_env
        assert (
            "distinct from CONVERSION_CONTEXT_SECRET and CONVERTER_SERVICE_TOKEN"
            in documented_env
        )
