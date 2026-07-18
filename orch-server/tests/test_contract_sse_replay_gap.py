"""Contract fixtures for session SSE replay and gap semantics."""

from collections import deque

from soulstream_server.service.session_broadcaster import SessionBroadcaster
from tests.orch_contract_helpers import load_contract_fixture


async def test_session_stream_replays_events_after_last_event_id():
    fixture = load_contract_fixture("sse_replay_gap.json")["sessionStream"]
    broadcaster = SessionBroadcaster()

    for event in fixture["events"]:
        await broadcaster.broadcast(event)

    replay = broadcaster.replay_since(fixture["resumeFrom"], broadcaster.instance_id)

    assert replay.gap is False
    assert [event_id for event_id, _ in replay.events] == fixture["expectedReplayEventIds"]
    assert replay.latest_id == len(fixture["events"])
    assert replay.instance_id == broadcaster.instance_id


async def test_ring_gap_and_instance_mismatch_require_snapshot_refetch():
    fixture = load_contract_fixture("sse_replay_gap.json")["gap"]
    broadcaster = SessionBroadcaster()
    broadcaster._recent_events = deque(maxlen=fixture["ringMaxlen"])

    for event in load_contract_fixture("sse_replay_gap.json")["sessionStream"]["events"]:
        await broadcaster.broadcast(event)

    ring_gap = broadcaster.replay_since(
        fixture["lastEventIdBeforeOldest"],
        broadcaster.instance_id,
    )
    instance_gap = broadcaster.replay_since(1, "different-instance")

    assert ring_gap.gap is True
    assert ring_gap.events == []
    assert ring_gap.latest_id == fixture["expectedLatestId"]
    assert instance_gap.gap is True
    assert instance_gap.events == []
