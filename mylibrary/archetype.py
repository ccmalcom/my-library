"""Reader archetype system -- 4-axis personality scoring via Claude Haiku."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

# ---------------------------------------------------------------------------
# Axis metadata
# ---------------------------------------------------------------------------

AXES = {
    "lens": {
        "name": "Lens",
        "left_letter": "I",
        "right_letter": "R",
        "left_label": "Immersive",
        "right_label": "Reflective",
        "description": "-1=Immersive (transported, escape), +1=Reflective (ideas, craft, challenge)",
    },
    "engine": {
        "name": "Engine",
        "left_letter": "P",
        "right_letter": "C",
        "left_label": "Plot-first",
        "right_label": "Character-first",
        "description": "-1=Plot-first (momentum, twists), +1=Character-first (interiority, relationships)",
    },
    "range": {
        "name": "Range",
        "left_letter": "B",
        "right_letter": "D",
        "left_label": "Broad",
        "right_label": "Deep",
        "description": "-1=Broad (genre eclectic), +1=Deep (genre loyal, series reader)",
    },
    "resonance": {
        "name": "Resonance",
        "left_letter": "H",
        "right_letter": "M",
        "left_label": "Heart",
        "right_label": "Mind",
        "description": "-1=Heart (emotional resonance, mood), +1=Mind (intellectual craft, structure)",
    },
}

# ---------------------------------------------------------------------------
# 16-archetype lookup dict
# ---------------------------------------------------------------------------

ARCHETYPES: dict[str, dict[str, str]] = {
    "IPBH": {"name": "The Wandering Escapist",     "tagline": "Give me a new world every week."},
    "IPBM": {"name": "The Plot Mechanic",           "tagline": "A perfect engine of a story."},
    "IPDH": {"name": "The Serial Thrill-Seeker",   "tagline": "One more chapter. Always one more."},
    "IPDM": {"name": "The Genre Architect",         "tagline": "The rules of the genre exist to be mastered."},
    "ICBH": {"name": "The Empathic Rover",          "tagline": "Show me how different people feel."},
    "ICBM": {"name": "The Character Analyst",       "tagline": "Tell me who they are, not what happens."},
    "ICDH": {"name": "The Devoted Fan",             "tagline": "I live in this world now."},
    "ICDM": {"name": "The Deep Empath",             "tagline": "I only finish books that feel true."},
    "RPBH": {"name": "The Conscious Adventurer",    "tagline": "Beautiful prose AND a great story."},
    "RPBM": {"name": "The Eclectic Critic",         "tagline": "I'll read anything once, and have opinions."},
    "RPDH": {"name": "The Committed Purist",        "tagline": "I know exactly what I like, and why."},
    "RPDM": {"name": "The Structural Connoisseur",  "tagline": "Architecture and execution, above all."},
    "RCBH": {"name": "The Literary Wanderer",       "tagline": "Voice and feeling, across every genre."},
    "RCBM": {"name": "The Cerebral Explorer",       "tagline": "Minds first -- give me complex characters and ideas."},
    "RCDH": {"name": "The Canon Keeper",            "tagline": "A few authors, read completely and deeply."},
    "RCDM": {"name": "The Cerebral Architect",      "tagline": "A well-constructed mind on the page -- that's everything."},
}


def _score_to_letter(axis_key: str, score: float) -> str:
    """Return the winning pole letter for a given axis score.

    Negative or zero -> left letter; positive -> right letter.
    """
    axis = AXES[axis_key]
    return axis["right_letter"] if score > 0.0 else axis["left_letter"]


def scores_to_code(lens: float, engine: float, range_: float, resonance: float) -> str:
    """Convert four axis scores to a 4-letter archetype code."""
    return (
        _score_to_letter("lens", lens)
        + _score_to_letter("engine", engine)
        + _score_to_letter("range", range_)
        + _score_to_letter("resonance", resonance)
    )


# ---------------------------------------------------------------------------
# Result dataclass
# ---------------------------------------------------------------------------

@dataclass
class ArchetypeResult:
    code: str
    name: str
    tagline: str
    axis_lens: float
    axis_engine: float
    axis_range: float
    axis_resonance: float
    lens_rationale: str
    engine_rationale: str
    range_rationale: str
    resonance_rationale: str
    derived_at: datetime


# ---------------------------------------------------------------------------
# Claude tool schema
# ---------------------------------------------------------------------------

_TOOL = {
    "name": "record_archetype_scores",
    "description": "Record the reader's axis scores derived from their taste profile.",
    "input_schema": {
        "type": "object",
        "properties": {
            "lens": {
                "type": "number",
                "description": "-1=Immersive (transported, escape), +1=Reflective (ideas, craft, challenge)",
            },
            "engine": {
                "type": "number",
                "description": "-1=Plot-first (momentum, twists), +1=Character-first (interiority, relationships)",
            },
            "range": {
                "type": "number",
                "description": "-1=Broad (genre eclectic), +1=Deep (genre loyal, series reader)",
            },
            "resonance": {
                "type": "number",
                "description": "-1=Heart (emotional resonance, mood), +1=Mind (intellectual craft, structure)",
            },
            "lens_rationale": {
                "type": "string",
                "description": "Brief rationale for the lens score.",
            },
            "engine_rationale": {
                "type": "string",
                "description": "Brief rationale for the engine score.",
            },
            "range_rationale": {
                "type": "string",
                "description": "Brief rationale for the range score.",
            },
            "resonance_rationale": {
                "type": "string",
                "description": "Brief rationale for the resonance score.",
            },
        },
        "required": [
            "lens",
            "engine",
            "range",
            "resonance",
            "lens_rationale",
            "engine_rationale",
            "range_rationale",
            "resonance_rationale",
        ],
    },
}

_MODEL = "claude-haiku-4-5-20251001"

_SYSTEM = (
    "You are a literary analyst scoring a reader's personality across 4 axes based on their "
    "taste traits. Each axis is a float from -1.0 (left pole) to +1.0 (right pole). "
    "Use the full range; avoid clustering near 0 unless the evidence is genuinely mixed. "
    "Call record_archetype_scores with all 8 fields."
)


def _build_prompt(traits: list) -> str:
    lines = ["Score this reader's taste profile across 4 axes.\n\nTaste traits:"]
    for t in traits:
        polarity = f" [{t.polarity}]" if getattr(t, "polarity", None) else ""
        lines.append(f"- {t.claim}{polarity}")
    lines.append(
        "\nAxes:\n"
        "  lens:      -1=Immersive (escape/absorption), +1=Reflective (ideas/craft)\n"
        "  engine:    -1=Plot-first (events/twists), +1=Character-first (interiority)\n"
        "  range:     -1=Broad (eclectic genres), +1=Deep (genre loyal, series)\n"
        "  resonance: -1=Heart (emotional/mood), +1=Mind (intellectual/structural)\n"
    )
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# derive_archetype
# ---------------------------------------------------------------------------

def derive_archetype(*, user_id: str | None = None) -> "ArchetypeResult":
    from .config import LOCAL_USER_ID
    from .db import init_db, utcnow, session_scope, ReaderArchetype, TasteTrait
    from .user_settings import resolve_anthropic_key

    if user_id is None:
        user_id = LOCAL_USER_ID

    init_db()

    api_key = resolve_anthropic_key(user_id)
    if not api_key:
        raise RuntimeError(
            "No Anthropic API key configured. Add one at /settings or set ANTHROPIC_API_KEY."
        )

    with session_scope() as session:
        traits = (
            session.query(TasteTrait)
            .filter(TasteTrait.user_id == user_id)
            .all()
        )
        if not traits:
            raise RuntimeError(
                "No taste profile found. Build your taste profile first."
            )

        from anthropic import Anthropic
        client = Anthropic(api_key=api_key)

        prompt = _build_prompt(traits)
        message = client.messages.create(
            model=_MODEL,
            max_tokens=512,
            system=_SYSTEM,
            tools=[_TOOL],
            tool_choice={"type": "tool", "name": "record_archetype_scores"},
            messages=[{"role": "user", "content": prompt}],
        )

        tool_input: dict = {}
        for block in message.content:
            if block.type == "tool_use":
                tool_input = block.input
                break

        lens = float(tool_input["lens"])
        engine = float(tool_input["engine"])
        range_ = float(tool_input["range"])
        resonance = float(tool_input["resonance"])
        code = scores_to_code(lens, engine, range_, resonance)
        archetype = ARCHETYPES[code]
        now = utcnow()

        row = (
            session.query(ReaderArchetype)
            .filter(ReaderArchetype.user_id == user_id)
            .one_or_none()
        )
        if row is None:
            row = ReaderArchetype(user_id=user_id)
            session.add(row)

        row.code = code
        row.archetype_name = archetype["name"]
        row.archetype_tagline = archetype["tagline"]
        row.axis_lens = lens
        row.axis_engine = engine
        row.axis_range = range_
        row.axis_resonance = resonance
        row.lens_rationale = tool_input.get("lens_rationale", "")
        row.engine_rationale = tool_input.get("engine_rationale", "")
        row.range_rationale = tool_input.get("range_rationale", "")
        row.resonance_rationale = tool_input.get("resonance_rationale", "")
        row.derived_at = now

        return ArchetypeResult(
            code=code,
            name=archetype["name"],
            tagline=archetype["tagline"],
            axis_lens=lens,
            axis_engine=engine,
            axis_range=range_,
            axis_resonance=resonance,
            lens_rationale=row.lens_rationale,
            engine_rationale=row.engine_rationale,
            range_rationale=row.range_rationale,
            resonance_rationale=row.resonance_rationale,
            derived_at=now,
        )
