from typer.testing import CliRunner

from mylibrary import directive
from mylibrary.cli import app
from mylibrary.config import LOCAL_USER_ID

runner = CliRunner()


def test_cli_directive_set_show_clear():
    r = runner.invoke(app, ["directive", "More short story collections."])
    assert r.exit_code == 0
    assert directive.get_directive(user_id=LOCAL_USER_ID)["nl_text"] == "More short story collections."

    r2 = runner.invoke(app, ["directive"])
    assert r2.exit_code == 0
    assert "More short story collections." in r2.stdout

    r3 = runner.invoke(app, ["directive", "--clear"])
    assert r3.exit_code == 0
    assert directive.get_directive(user_id=LOCAL_USER_ID) is None
