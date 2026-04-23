"""Minimal Paradox/Clausewitz script tokenizer + parser.

Grammar we care about:
    key = value
    key = { value value value }          # bare list
    key = { sub_key = value ... }        # nested block
    1453.5.29 = { ... }                  # date-keyed block
    # comment to end of line

Encoding is ISO-8859-1 throughout EU4 files. Strings may be quoted with "...".
Scalars are strings, ints, floats, booleans (yes/no), or dates (Y.M.D).
Keys may repeat (e.g. multiple `add_core = X`) so a block preserves order.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterator


_DATE_RE = re.compile(r"^\d{1,4}\.\d{1,2}\.\d{1,2}$")
_INT_RE = re.compile(r"^-?\d+$")
_FLOAT_RE = re.compile(r"^-?\d+\.\d+$")


@dataclass
class Date:
    y: int
    m: int
    d: int

    @classmethod
    def parse(cls, s: str) -> "Date":
        y, m, d = s.split(".")
        return cls(int(y), int(m), int(d))

    def iso(self) -> str:
        return f"{self.y:04d}-{self.m:02d}-{self.d:02d}"

    def __lt__(self, other: "Date") -> bool:
        return (self.y, self.m, self.d) < (other.y, other.m, other.d)


# A scalar in the script can be any of these python types:
Scalar = str | int | float | bool | Date
Value = "Scalar | Block"


@dataclass
class Block:
    """Ordered list of (key, value) entries. Bare list items have key=None."""

    entries: list[tuple[str | None, object]] = field(default_factory=list)

    def get(self, key: str, default=None):
        for k, v in self.entries:
            if k == key:
                return v
        return default

    def get_all(self, key: str) -> list[object]:
        return [v for k, v in self.entries if k == key]

    def pairs(self) -> Iterator[tuple[str, object]]:
        for k, v in self.entries:
            if k is not None:
                yield k, v

    def bare(self) -> list[object]:
        return [v for k, v in self.entries if k is None]


# --- tokenizer ----------------------------------------------------------------

_SPECIALS = set("{}=")


def _tokens(text: str) -> Iterator[str]:
    i, n = 0, len(text)
    while i < n:
        c = text[i]
        if c.isspace():
            i += 1
            continue
        if c == "#":
            # comment to end of line
            j = text.find("\n", i)
            i = n if j == -1 else j + 1
            continue
        if c in _SPECIALS:
            yield c
            i += 1
            continue
        if c == '"':
            j = text.find('"', i + 1)
            if j == -1:
                raise ValueError(f"unterminated string starting at offset {i}")
            yield text[i : j + 1]
            i = j + 1
            continue
        # identifier / number / date — read until whitespace or special
        j = i
        while j < n and not text[j].isspace() and text[j] not in _SPECIALS and text[j] != "#":
            j += 1
        yield text[i:j]
        i = j


def _to_scalar(tok: str) -> Scalar:
    if tok.startswith('"') and tok.endswith('"'):
        return tok[1:-1]
    if tok == "yes":
        return True
    if tok == "no":
        return False
    if _DATE_RE.match(tok):
        return Date.parse(tok)
    if _INT_RE.match(tok):
        return int(tok)
    if _FLOAT_RE.match(tok):
        return float(tok)
    return tok  # bare identifier, treated as string


# --- parser -------------------------------------------------------------------


class _Parser:
    def __init__(self, toks: list[str]) -> None:
        self.toks = toks
        self.i = 0

    def _peek(self) -> str | None:
        return self.toks[self.i] if self.i < len(self.toks) else None

    def _pop(self) -> str:
        t = self.toks[self.i]
        self.i += 1
        return t

    def parse_block(self, at_root: bool) -> Block:
        """Parse until `}` (or EOF if at_root). May be either list-of-pairs
        (`key = value` entries) or bare-value list; we allow a mix."""
        block = Block()
        while True:
            t = self._peek()
            if t is None:
                if at_root:
                    return block
                raise ValueError("unexpected EOF inside block")
            if t == "}":
                self._pop()
                return block
            if t == "=":
                raise ValueError(f"unexpected '=' at token {self.i}")
            # consume one token as potential key
            first = self._pop()
            nxt = self._peek()
            if nxt == "=":
                self._pop()  # eat =
                val = self._parse_value()
                block.entries.append((first, val))
            else:
                # bare value in a list (sea_starts = { 1 2 3 })
                block.entries.append((None, _to_scalar(first)))

    def _parse_value(self) -> object:
        t = self._pop()
        if t == "{":
            return self.parse_block(at_root=False)
        if t in ("}", "="):
            raise ValueError(f"unexpected {t!r} at token {self.i - 1}")
        return _to_scalar(t)


def parse_text(text: str) -> Block:
    toks = list(_tokens(text))
    return _Parser(toks).parse_block(at_root=True)


def parse_file(path: str | Path, encoding: str = "latin-1") -> Block:
    with open(path, "r", encoding=encoding, errors="replace") as f:
        return parse_text(f.read())


# --- tiny self-test when run directly -----------------------------------------

if __name__ == "__main__":
    sample = """
    # sample
    government = monarchy
    color = { 126 203 120 }
    capital = 149
    1444.1.1 = {
        monarch = { name = "Mehmed II Fatih" dynasty = Osmanoglu adm = 6 dip = 4 mil = 6 }
    }
    add_core = BYZ
    add_core = TUR
    sea = { 1 2 3 4 5 }
    """
    root = parse_text(sample)
    assert root.get("government") == "monarchy"
    assert root.get("capital") == 149
    color = root.get("color")
    assert isinstance(color, Block) and color.bare() == [126, 203, 120]
    assert root.get_all("add_core") == ["BYZ", "TUR"]
    dkey = next(k for k, _ in root.entries if isinstance(k, str) and k.startswith("1444"))
    assert dkey == "1444.1.1"
    print("pdx_parser self-test OK")
