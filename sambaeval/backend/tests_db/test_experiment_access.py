"""Experiment ownership + generator-catalog enforcement at the API (db mode).

Requests are made as chosen users by swapping the auth middleware's user
resolver, so owner / other user / admin can be exercised without OAuth.
"""

from __future__ import annotations

import uuid

import pytest
from fastapi.testclient import TestClient

from sambaeval import storage, storage_db
from sambaeval.api import auth as auth_routes
from sambaeval.api.main import app
from sambaeval.authz import CurrentUser, get_or_create_user
from sambaeval.db import session_scope
from sambaeval.generators import GeneratorNotAllowed, resolve_generator_path
from sambaeval.models_db import Generator

ECHO_PATH = "backend/tests/fixtures/echo_generator.py"


def _user(is_admin: bool = False) -> CurrentUser:
    email = f"acl-{uuid.uuid4().hex[:8]}@sambanova.ai"
    with session_scope() as session:
        u = get_or_create_user(session, email=email, name="ACL")
        u.is_admin = is_admin
        return CurrentUser(id=u.id, email=u.email, name=u.name, is_admin=is_admin)


@pytest.fixture
def as_user(monkeypatch):
    """``as_user(u)`` makes subsequent requests authenticate as ``u``."""
    current: dict = {}
    monkeypatch.setattr(auth_routes, "resolve_user", lambda request: current.get("u"))

    def _set(u: CurrentUser) -> None:
        current["u"] = u

    return _set


@pytest.fixture
def client():
    return TestClient(app)


def _body(exp_id: str, **over) -> dict:
    body = {
        "id": exp_id,
        "name": "acl",
        "models": [{"name": "echo", "provider_name": "Echo"}],
        "dataset": [{"example_id": 0, "prompt": "hi", "expected_output": "hi"}],
        "scorer": {"type": "heuristic"},
        "output_generator": "echo_test",
        "private": True,
    }
    body.update(over)
    return body


def _make_owned(client, as_user, private: bool):
    owner = _user()
    as_user(owner)
    eid = f"acl_{uuid.uuid4().hex[:6]}"
    r = client.post("/api/experiments", json=_body(eid, private=private))
    assert r.status_code == 200
    return eid, owner


def _drop(eid: str) -> None:
    from sambaeval.models_db import Experiment

    with session_scope() as session:
        row = session.get(Experiment, eid)
        if row is not None:
            session.delete(row)  # cascades to runs/results/errors


@pytest.fixture
def owned(client, as_user):
    """A private experiment created by a fresh owner; yields (id, owner)."""
    eid, owner = _make_owned(client, as_user, private=True)
    yield eid, owner
    _drop(eid)


@pytest.fixture
def owned_public(client, as_user):
    """A public experiment created by a fresh owner; yields (id, owner)."""
    eid, owner = _make_owned(client, as_user, private=False)
    yield eid, owner
    _drop(eid)


# --------------------------------------------------------------------------- #
# Ticket 01 — owner-only edit / delete
# --------------------------------------------------------------------------- #
def test_non_owner_cannot_update(client, as_user, owned, owned_public):
    # A private one is invisible (404, existence not revealed); a public one is
    # visible but read-only (403).
    for (eid, owner), status, vis in ((owned, 404, "private"), (owned_public, 403, "public")):
        as_user(_user())
        r = client.put(f"/api/experiments/{eid}", json=_body(eid, name="changed", private=False))
        assert r.status_code == status
        assert storage_db.experiment_acl(eid) == (owner.id, vis)


def test_non_owner_cannot_overwrite_via_create(client, as_user, owned):
    eid, owner = owned
    as_user(_user())
    r = client.post("/api/experiments", json=_body(eid, name="changed", private=False))
    assert r.status_code == 409
    assert storage_db.experiment_acl(eid) == (owner.id, "private")


def test_non_owner_cannot_delete(client, as_user, owned, owned_public):
    for (eid, _), status in ((owned, 404), (owned_public, 403)):
        as_user(_user())
        assert client.delete(f"/api/experiments/{eid}").status_code == status
        assert storage_db.experiment_acl(eid) is not None


def test_owner_can_update_and_delete(client, as_user, owned):
    eid, owner = owned
    as_user(owner)
    r = client.put(f"/api/experiments/{eid}", json=_body(eid, name="renamed"))
    assert r.status_code == 200 and r.json()["experiment"]["name"] == "renamed"
    assert client.delete(f"/api/experiments/{eid}").status_code == 200
    assert storage_db.experiment_acl(eid) is None


def test_admin_can_update_and_delete(client, as_user, owned):
    eid, owner = owned
    as_user(_user(is_admin=True))
    assert client.put(f"/api/experiments/{eid}", json=_body(eid)).status_code == 200
    # Admin edits don't transfer ownership.
    assert storage_db.experiment_acl(eid)[0] == owner.id
    assert client.delete(f"/api/experiments/{eid}").status_code == 200


# --------------------------------------------------------------------------- #
# Ticket 03 — generators from the enabled catalog only
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(
    "ref",
    [
        "/etc/passwd.py",                                  # absolute path
        "backend/tests/../tests/fixtures/echo_generator.py",  # traversal variant
        "./backend/tests/fixtures/echo_generator.py",      # spelling variant
        "scripts/generators/not_in_catalog.py",
        "no_such_key",
    ],
)
def test_save_rejects_non_catalog_generator(client, as_user, ref):
    as_user(_user())
    eid = f"gen_{uuid.uuid4().hex[:6]}"
    r = client.post("/api/experiments", json=_body(eid, output_generator=ref))
    assert r.status_code == 400
    assert storage_db.experiment_acl(eid) is None
    with pytest.raises(GeneratorNotAllowed):
        resolve_generator_path(ref)


def test_catalog_key_and_legacy_path_both_resolve():
    by_key = resolve_generator_path("echo_test")
    by_path = resolve_generator_path(ECHO_PATH)
    assert by_key == by_path and by_key.name == "echo_generator.py"
    assert resolve_generator_path("").name == "default_generator.py"


def test_disabled_generator_is_refused(client, as_user):
    key = f"off_{uuid.uuid4().hex[:6]}"
    with session_scope() as session:
        session.add(
            Generator(
                key=key, display_name="off", script_path=ECHO_PATH + "#" + key,
                requires_sandbox=False, enabled=False,
            )
        )
    try:
        as_user(_user())
        r = client.post("/api/experiments", json=_body(f"gen_{key}", output_generator=key))
        assert r.status_code == 400
    finally:
        with session_scope() as session:
            session.delete(session.get(Generator, key))


def test_run_refuses_stored_non_catalog_generator(client, as_user):
    """A non-catalog value stored without the API (e.g. a row saved earlier)
    is refused at run time too."""
    owner = _user()
    as_user(owner)
    eid = f"gen_{uuid.uuid4().hex[:6]}"
    from sambaeval import context
    from sambaeval.models import Experiment

    with context.owner(owner.id):
        storage.save_experiment(
            Experiment.model_validate({**_body(eid), "output_generator": "/tmp/other.py"})
        )
    try:
        r = client.post(f"/api/experiments/{eid}/run?mode=new")
        assert r.status_code == 400
        assert storage_db.count_active_runs_for_owner(owner.id) == 0
    finally:
        with context.owner(owner.id):
            storage.delete_experiment(eid)


def test_sandbox_gate_uses_catalog_entry():
    """Both the key and the legacy path of a sandbox generator are blocked when
    code execution is off (the test env leaves SANDBOX_ENABLED unset)."""
    from sambaeval.api import main as api_main
    from sambaeval.models import Experiment

    assert api_main.settings.sandbox_enabled is False
    exp = Experiment.model_validate(
        {**_body("x"), "output_generator": "scripts/generators/scicode_generator.py"}
    )
    assert api_main._sandbox_block_reason(exp) is not None
    exp_key = Experiment.model_validate({**_body("x"), "output_generator": "scicode"})
    assert api_main._sandbox_block_reason(exp_key) is not None


# --------------------------------------------------------------------------- #
# Ticket 02 — visibility on run / result / run-control routes
# --------------------------------------------------------------------------- #
@pytest.fixture
def with_run(owned):
    """``owned`` plus one queued run with a result row and an error entry."""
    from sambaeval import context
    from sambaeval.models import ResultRow

    eid, owner = owned
    with context.owner(owner.id):
        exp = storage.get_experiment(eid)
        label = storage_db.enqueue_run(
            exp, mode="new", params={"concurrency": 1}, owner_id=owner.id
        )
        storage_db.upsert_run_result_row(
            eid,
            label,
            ResultRow(
                result_id=0, status="completed", provider="Echo", model="echo",
                example_id=0, output="hi", score=1.0, weight=1.0,
            ),
        )
    return eid, owner, label


READS = [
    ("get", "/api/experiments/{eid}/runs"),
    ("get", "/api/experiments/{eid}/results"),
    ("get", "/api/experiments/{eid}/results?run_id={label}"),
    ("get", "/api/experiments/{eid}/results?format=csv&run_id={label}"),
    ("get", "/api/experiments/{eid}/errors?run_id={label}"),
]
WRITES = [
    ("delete", "/api/experiments/{eid}/runs?run_id={label}"),
    ("post", "/api/experiments/{eid}/run/cancel?run_id={label}"),
    ("post", "/api/experiments/{eid}/run/pause?run_id={label}"),
    ("post", "/api/experiments/{eid}/run/terminate?run_id={label}"),
    ("post", "/api/experiments/{eid}/run?mode=resume&run_id={label}"),
    ("post", "/api/experiments/{eid}/run?mode=retry&run_id={label}"),
    ("post", "/api/experiments/{eid}/run?mode=new"),
]


def _call(client, method, url, eid, label):
    url = url.format(eid=eid, label=label)
    if url.endswith("/runs/merge"):
        return client.post(url, json={"from_run_id": label, "into_run_id": label})
    return getattr(client, method)(url)


@pytest.mark.parametrize("method,url", READS + WRITES + [("post", "/api/experiments/{eid}/runs/merge")])
def test_private_run_routes_not_found_for_others(client, as_user, with_run, method, url):
    eid, owner, label = with_run
    as_user(_user())
    r = _call(client, method, url, eid, label)
    assert r.status_code == 404
    # Nothing changed: the run is still queued, uncontrolled, with its row.
    assert storage_db.run_status(eid, label) == "queued"
    assert storage_db.get_run_control(eid, label) == "none"
    assert len(storage.read_run_results(eid, label)) == 1


def test_public_experiment_runs_are_readable_but_not_controllable(
    client, as_user, owned_public
):
    from sambaeval import context

    eid, owner = owned_public
    with context.owner(owner.id):
        label = storage_db.enqueue_run(
            storage.get_experiment(eid), mode="new", params={}, owner_id=owner.id
        )
    as_user(_user())
    for method, url in READS:
        assert _call(client, method, url, eid, label).status_code in (200, 404), url
    assert client.get(f"/api/experiments/{eid}/runs").status_code == 200
    for method, url in WRITES + [("post", "/api/experiments/{eid}/runs/merge")]:
        assert _call(client, method, url, eid, label).status_code == 403, url
    assert storage_db.run_status(eid, label) == "queued"
    assert storage_db.count_active_runs_for_owner(owner.id) == 1


def test_owner_and_admin_keep_access(client, as_user, with_run):
    eid, owner, label = with_run
    for who in (owner, _user(is_admin=True)):
        as_user(who)
        assert client.get(f"/api/experiments/{eid}/runs").status_code == 200
        r = client.get(f"/api/experiments/{eid}/results?run_id={label}")
        assert r.status_code == 200 and len(r.json()["results"]) == 1
    as_user(owner)
    assert client.post(f"/api/experiments/{eid}/run/pause?run_id={label}").status_code == 200
    assert storage_db.get_run_control(eid, label) == "pause"


def test_share_token_grants_read_only(client, as_user, with_run):
    eid, owner, label = with_run
    token = storage_db.ensure_experiment_share_token(eid)
    as_user(_user())
    r = client.get(f"/api/experiments/{eid}/results?run_id={label}&token={token}")
    assert r.status_code == 200 and len(r.json()["results"]) == 1
    # A token lets you look, not act.
    r = client.post(f"/api/experiments/{eid}/run/cancel?run_id={label}&token={token}")
    assert r.status_code == 403
    # A token for a different experiment opens nothing here.
    other_eid, _ = _make_owned(client, as_user, private=True)
    try:
        other_token = storage_db.ensure_experiment_share_token(other_eid)
        as_user(_user())
        r = client.get(f"/api/experiments/{eid}/runs?token={other_token}")
        assert r.status_code == 404
    finally:
        _drop(other_eid)
