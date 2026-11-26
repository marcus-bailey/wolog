"""Spec §4.3 Rotation, DAY-3: add Turns (repeats allowed), reorder, remove, Drop and Put back."""

from concurrent.futures import ThreadPoolExecutor
from typing import Any

import httpx2
import pytest
from fastapi.testclient import TestClient


class Rotation:
    """A Routine with Days, and helpers that read its rotation as Day names."""

    def __init__(self, client: TestClient, *days: str, routine: str = "PPL") -> None:
        self.client = client
        res = client.post("/api/routines", json={"name": routine})
        assert res.status_code == 201, res.json()
        self.id: int = res.json()["id"]
        self.day: dict[str, int] = {}
        for name in days:
            res = client.post(f"/api/routines/{self.id}/days", json={"name": name})
            assert res.status_code == 201, res.json()
            self.day[name] = res.json()["id"]

    def detail(self) -> dict[str, Any]:
        body: dict[str, Any] = self.client.get(f"/api/routines/{self.id}").json()
        return body

    def names(self, body: dict[str, Any] | None = None) -> list[str]:
        body = body or self.detail()
        by_id = {d["id"]: d["name"] for d in body["days"]}
        return [by_id[t["day_id"]] for t in body["rotation"]]

    def turn_ids(self) -> list[int]:
        return [t["id"] for t in self.detail()["rotation"]]

    def add(self, day: str) -> httpx2.Response:
        return self.client.post(f"/api/routines/{self.id}/turns", json={"day_id": self.day[day]})

    def reorder(self, turn_ids: list[int]) -> httpx2.Response:
        return self.client.put(f"/api/routines/{self.id}/turns", json={"turn_ids": turn_ids})

    def remove(self, turn_id: int) -> httpx2.Response:
        return self.client.delete(f"/api/routines/{self.id}/turns/{turn_id}")

    def drop(self, day: str) -> httpx2.Response:
        return self.client.post(f"/api/days/{self.day[day]}/drop")

    def put_back(self, day: str) -> httpx2.Response:
        return self.client.post(f"/api/days/{self.day[day]}/put-back")


# Add a Turn


def test_each_new_day_starts_with_one_turn_in_order(client: TestClient) -> None:
    assert Rotation(client, "Push", "Pull", "Legs").names() == ["Push", "Pull", "Legs"]


def test_add_a_turn_appends_and_a_day_may_have_several(client: TestClient) -> None:
    r = Rotation(client, "A", "B", "C")
    res = r.add("A")
    assert res.status_code == 200
    assert r.names(res.json()) == ["A", "B", "C", "A"]
    r.add("A")
    assert r.names() == ["A", "B", "C", "A", "A"]


def test_a_turn_for_a_day_of_another_routine_is_refused(client: TestClient) -> None:
    r = Rotation(client, "Push")
    other = Rotation(client, "Upper", routine="Upper Lower")
    res = client.post(f"/api/routines/{r.id}/turns", json={"day_id": other.day["Upper"]})
    assert res.status_code == 404
    assert res.json() == {"code": "not_found", "message": "That Day is not in this Routine."}
    assert r.names() == ["Push"]
    assert other.names() == ["Upper"]


@pytest.mark.parametrize("day_id", [999, 0, 2**31])
def test_a_turn_for_an_unknown_day_is_refused(client: TestClient, day_id: int) -> None:
    r = Rotation(client, "Push")
    res = client.post(f"/api/routines/{r.id}/turns", json={"day_id": day_id})
    assert res.json()["code"] == "not_found"


def test_rotation_changes_on_an_unknown_routine_are_refused(client: TestClient) -> None:
    assert client.post("/api/routines/999/turns", json={"day_id": 1}).json()["message"] == (
        "That Routine no longer exists."
    )
    assert client.put("/api/routines/999/turns", json={"turn_ids": []}).status_code == 404
    assert client.delete("/api/routines/999/turns/1").status_code == 404


def test_concurrent_additions_each_get_their_own_place(client: TestClient) -> None:
    r = Rotation(client, "A")
    with ThreadPoolExecutor(6) as pool:
        results = list(pool.map(lambda _: r.add("A"), range(6)))
    assert [res.status_code for res in results] == [200] * 6
    assert r.names() == ["A"] * 7


# Reorder


def test_reorder_keeps_each_turns_identity(client: TestClient) -> None:
    r = Rotation(client, "A", "B", "C")
    r.add("A")
    a1, b, c, a2 = r.turn_ids()
    res = r.reorder([a2, c, a1, b])
    assert res.status_code == 200
    assert [t["id"] for t in res.json()["rotation"]] == [a2, c, a1, b]
    assert r.names() == ["A", "C", "A", "B"]


def test_old_positions_are_not_remembered(client: TestClient) -> None:
    r = Rotation(client, "A", "B", "C")
    a, b, c = r.turn_ids()
    r.reorder([c, b, a])
    r.add("B")  # to the end of the current order, not back into an old place
    assert r.names() == ["C", "B", "A", "B"]
    r.remove(c)
    assert r.names() == ["B", "A", "B"]


@pytest.mark.parametrize("order", ["missing", "extra", "repeated", "foreign"])
def test_a_reorder_must_name_every_turn_once(client: TestClient, order: str) -> None:
    r = Rotation(client, "A", "B")
    other = Rotation(client, "X", routine="Other")
    a, b = r.turn_ids()
    given = {
        "missing": [b],
        "extra": [b, a, 999],
        "repeated": [b, b],
        "foreign": [b, other.turn_ids()[0]],
    }[order]
    res = r.reorder(given)
    assert res.status_code == 409
    assert res.json() == {
        "code": "rotation_changed",
        "message": "The rotation changed since you loaded it. Reload and try again.",
    }
    assert r.names() == ["A", "B"]


# Remove a Turn


def test_removing_a_turn_is_always_allowed_and_the_rotation_may_be_empty(client: TestClient) -> None:
    r = Rotation(client, "A", "B")
    a, b = r.turn_ids()
    assert r.names(r.remove(a).json()) == ["B"]
    res = r.remove(b)
    assert res.status_code == 200
    assert res.json()["rotation"] == []
    assert [d["name"] for d in res.json()["days"]] == ["A", "B"]  # the Days stay, off the rotation


def test_removing_one_of_a_days_turns_leaves_the_others(client: TestClient) -> None:
    r = Rotation(client, "A", "B")
    r.add("A")
    a1, b, a2 = r.turn_ids()
    r.remove(a1)
    assert r.turn_ids() == [b, a2]
    assert r.names() == ["B", "A"]


def test_removing_a_turn_not_on_the_rotation_is_refused(client: TestClient) -> None:
    r = Rotation(client, "A")
    other = Rotation(client, "X", routine="Other")
    res = r.remove(other.turn_ids()[0])
    assert res.status_code == 404
    assert res.json() == {"code": "not_found", "message": "That Turn is no longer on the rotation."}
    assert other.names() == ["X"]
    assert r.remove(999).status_code == 404


# Drop and Put back


def test_drop_removes_all_of_a_days_turns(client: TestClient) -> None:
    r = Rotation(client, "A", "B", "C")
    r.add("A")
    r.add("B")
    res = r.drop("A")
    assert res.status_code == 200
    assert r.names(res.json()) == ["B", "C", "B"]
    day_a = next(d for d in res.json()["days"] if d["name"] == "A")
    assert day_a["id"] == r.day["A"]  # the Day stays in the Routine


def test_drop_keeps_the_days_lines(client: TestClient) -> None:
    r = Rotation(client, "A")
    client.post(f"/api/days/{r.day['A']}/lines", json={"name": "Squat"})
    res = r.drop("A")
    assert res.json()["days"][0]["lines"][0]["exercise"]["name"] == "Squat"


def test_dropping_a_day_already_off_the_rotation_changes_nothing(client: TestClient) -> None:
    r = Rotation(client, "A", "B")
    r.drop("A")
    res = r.drop("A")
    assert res.status_code == 200
    assert r.names(res.json()) == ["B"]


def test_put_back_adds_one_turn_at_the_end(client: TestClient) -> None:
    r = Rotation(client, "A", "B", "C")
    r.add("A")
    r.drop("A")
    res = r.put_back("A")
    assert res.status_code == 200
    assert r.names(res.json()) == ["B", "C", "A"]


def test_put_back_of_a_day_on_the_rotation_is_refused(client: TestClient) -> None:
    r = Rotation(client, "Push", "Pull")
    res = r.put_back("Push")
    assert res.status_code == 409
    assert res.json() == {
        "code": "day_on_rotation",
        "message": "“Push” is already on the rotation. Add a Turn for it to repeat it.",
    }
    assert r.names() == ["Push", "Pull"]


def test_a_day_off_the_rotation_can_get_a_turn_by_add_too(client: TestClient) -> None:
    r = Rotation(client, "A", "B")
    r.drop("A")
    r.add("A")
    assert r.names() == ["B", "A"]


def test_drop_and_put_back_on_an_unknown_day_are_refused(client: TestClient) -> None:
    for action in ("drop", "put-back"):
        res = client.post(f"/api/days/999/{action}")
        assert res.status_code == 404
        assert res.json() == {"code": "not_found", "message": "That Day no longer exists."}


def test_concurrent_put_backs_add_one_turn(client: TestClient) -> None:
    r = Rotation(client, "A", "B")
    r.drop("A")
    with ThreadPoolExecutor(6) as pool:
        results = list(pool.map(lambda _: r.put_back("A"), range(6)))
    assert sorted(res.status_code for res in results) == [200] + [409] * 5
    assert r.names() == ["B", "A"]


def test_rotations_of_different_routines_are_separate(client: TestClient) -> None:
    ppl = Rotation(client, "Push", "Pull")
    ul = Rotation(client, "Upper", "Lower", routine="Upper Lower")
    ppl.drop("Push")
    ul.add("Upper")
    assert ppl.names() == ["Pull"]
    assert ul.names() == ["Upper", "Lower", "Upper"]


# Refusal shapes


def test_the_schema_lists_only_the_refusals_each_route_can_give(client: TestClient) -> None:
    paths = client.get("/api/openapi.json").json()["paths"]
    codes = {
        (method, path): sorted(c for c in op["responses"] if c[0] in "45")
        for path, ops in paths.items()
        for method, op in ops.items()
        if op["tags"] == ["rotation"]
    }
    assert codes == {
        ("post", "/api/routines/{routine_id}/turns"): ["404", "422"],
        ("put", "/api/routines/{routine_id}/turns"): ["404", "409", "422"],
        ("delete", "/api/routines/{routine_id}/turns/{turn_id}"): ["404", "422"],
        ("post", "/api/days/{day_id}/drop"): ["404", "422"],
        ("post", "/api/days/{day_id}/put-back"): ["404", "409", "422"],
    }
