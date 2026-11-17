"""A renamed account: reviewed games stay matched and keep counting as yours."""
from app import config, storage


def test_game_key_ignores_what_varies():
    assert storage.game_key("https://www.chess.com/game/live/123/") == "chess.com/game/live/123"
    assert storage.game_key("http://chess.com/game/live/123?ref=x") == "chess.com/game/live/123"
    assert storage.game_key("https://lichess.org/AbCdEfGh/black") == "lichess.org/abcdefgh"
    assert storage.game_key("https://lichess.org/AbCdEfGh1234") == "lichess.org/abcdefgh"
    assert storage.game_key(None) is None and storage.game_key("") is None


def test_review_found_by_address_when_the_id_changed(monkeypatch):
    sums = [{"id": "oldhash", "url": "https://www.chess.com/game/live/42", "me": "b",
             "accuracy": {"w": 70.0, "b": 81.5}, "depth": 16}]
    monkeypatch.setattr(storage, "summaries", lambda: sums)
    idx = storage.review_index()
    addr = storage.by_address(idx)
    # Same game, new player name in the PGN -> a different id, same address.
    hit = storage.find_review(idx, addr, "newhash", "https://www.chess.com/game/live/42")
    assert hit and hit["id"] == "oldhash" and hit["accuracy"] == 81.5
    assert storage.find_review(idx, addr, "oldhash", None)["id"] == "oldhash"
    assert storage.find_review(idx, addr, "other", "https://www.chess.com/game/live/43") is None


def test_renaming_keeps_the_old_name(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "SETTINGS_FILE", tmp_path / "settings.json")
    config.save_settings({"chesscom_username": "OldName", "lichess_username": "Lich"})
    s = config.save_settings({"chesscom_username": "NewName"})
    assert s["chesscom_username"] == "NewName" and s["aliases"] == ["OldName"]
    assert {"oldname", "newname", "lich"} <= config.my_names(s)
    # Saving again, or changing only the letter case, adds nothing twice.
    s = config.save_settings({"chesscom_username": "newname"})
    assert s["aliases"] == ["OldName"]
    # Renaming back: the main name leaves the list, the one just given up joins it.
    s = config.save_settings({"chesscom_username": "OldName"})
    assert s["aliases"] == ["newname"]
