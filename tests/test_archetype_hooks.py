from mylibrary.archetype import ARCHETYPES, ARCHETYPE_HOOKS


def test_every_archetype_has_a_hook():
    assert set(ARCHETYPE_HOOKS) == set(ARCHETYPES)


def test_hooks_are_nonempty_lowercase_clauses():
    for code, hook in ARCHETYPE_HOOKS.items():
        assert hook and hook.strip() == hook, code
        # Hooks extend "You're the one who ..." so they start lowercase, no trailing period.
        assert hook[0].islower(), code
        assert not hook.endswith("."), code


def test_specific_hook_copy_is_canon():
    assert ARCHETYPE_HOOKS["ICDH"] == "reread the whole series to get ready for the new one"
    assert ARCHETYPE_HOOKS["RCDH"] == "keeps a canon and tends it like a garden"
