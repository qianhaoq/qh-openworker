from coworker.acp.process_env import build_agent_env, build_minimal_env


def test_agent_environment_excludes_undeclared_ambient_secrets(monkeypatch):
    monkeypatch.setenv("PATH", "/usr/bin")
    monkeypatch.setenv("UNDECLARED_SECRET", "must-not-leak")
    monkeypatch.setenv("DECLARED_SECRET", "allowed")
    profile = {
        "role": "executor",
        "permission_policy": "coding-default",
        "secret_refs": ["DECLARED_SECRET"],
    }

    env = build_agent_env(profile)

    assert env["PATH"] == "/usr/bin"
    assert env["DECLARED_SECRET"] == "allowed"
    assert "UNDECLARED_SECRET" not in env


def test_read_only_agents_never_receive_secret_refs(monkeypatch):
    monkeypatch.setenv("DECLARED_SECRET", "must-not-leak")
    profile = {
        "role": "reviewer",
        "permission_policy": "read-only",
        "secret_refs": ["DECLARED_SECRET"],
    }

    assert "DECLARED_SECRET" not in build_agent_env(profile)


def test_resolved_secret_value_wins_over_ambient(monkeypatch):
    monkeypatch.setenv("DECLARED_SECRET", "ambient")
    profile = {
        "role": "main",
        "permission_policy": "coding-default",
        "secret_refs": ["DECLARED_SECRET"],
    }

    env = build_agent_env(
        profile,
        resolved_secrets={"DECLARED_SECRET": "resolved"},
    )

    assert env["DECLARED_SECRET"] == "resolved"


def test_minimal_host_subprocess_environment_excludes_credentials(monkeypatch):
    monkeypatch.setenv("PATH", "/usr/bin")
    monkeypatch.setenv("GITHUB_TOKEN", "must-not-leak")

    env = build_minimal_env()

    assert env["PATH"] == "/usr/bin"
    assert "GITHUB_TOKEN" not in env
