from fastapi.testclient import TestClient
from main import app


client = TestClient(app)


def test_server_health():
    response = client.get("/")

    assert response.status_code == 200
    assert response.json() == {
        "message": "SyncTube Signaling Server is running!"
    }


def test_turn_credentials_falls_back_to_stun_when_unconfigured():
    """Without a Cloudflare key the endpoint must still return usable STUN servers."""
    response = client.get("/turn-credentials")

    assert response.status_code == 200
    body = response.json()
    assert body["turn"] is False
    assert len(body["iceServers"]) >= 1
    assert all("urls" in server for server in body["iceServers"])
    assert any("stun:" in server["urls"] for server in body["iceServers"])
