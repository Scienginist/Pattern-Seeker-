"""표준 라이브러리만 쓰는 최소 PDF 텍스트 추출기 (pypdf 가 없을 때의 대체 경로).

대상: 장비 소프트웨어의 '인쇄 → PDF'(예: Microsoft Print to PDF)처럼 구조가 단순한 문서.
- 지원: 일반 객체(obj … endobj), FlateDecode 스트림, Type0/Identity-H + ToUnicode, 단순 1바이트 폰트,
        Tj / TJ / ' / " 문자열, Tm / Td / TD / T* 위치 → 같은 줄(y)끼리 x 순으로 이어 붙임
- 미지원: 객체 스트림(ObjStm), 암호화, 스캔 이미지(OCR 필요). 이 경우 PdfTextError 를 낸다.
추출 결과는 항상 사용자가 저장 전에 확인한다는 전제로 쓴다.
"""
import re
import zlib


class PdfTextError(Exception):
    pass


_OBJ_RX = re.compile(rb"(\d+)\s+(\d+)\s+obj(.*?)endobj", re.S)


def _objects(data):
    objs = {}
    for m in _OBJ_RX.finditer(data):
        objs[int(m.group(1))] = m.group(3)
    return objs


def _stream(body):
    i = body.find(b"stream")
    if i < 0:
        return None
    head = body[:i]
    raw = body[i + 6:]
    raw = raw[2:] if raw.startswith(b"\r\n") else raw[1:] if raw[:1] in (b"\n", b"\r") else raw
    j = raw.rfind(b"endstream")
    raw = raw[:j] if j >= 0 else raw
    if b"/FlateDecode" in head:
        try:
            return zlib.decompress(raw)
        except zlib.error:
            try:
                return zlib.decompressobj().decompress(raw.rstrip(b"\r\n"))
            except zlib.error as e:
                raise PdfTextError(f"압축 해제 실패: {e}")
    if b"/Filter" in head:
        return None  # 이미지 등 다른 필터는 텍스트와 무관
    return raw


def _ref(body, key):
    m = re.search(rb"/" + key + rb"\s+(\d+)\s+0\s+R", body)
    return int(m.group(1)) if m else None


def _refs_list(body, key):
    m = re.search(rb"/" + key + rb"\s*\[([^\]]*)\]", body)
    if m:
        return [int(x) for x in re.findall(rb"(\d+)\s+0\s+R", m.group(1))]
    r = _ref(body, key)
    return [r] if r else []


def _cmap(text):
    """ToUnicode CMap → {코드(int): 문자열}, 코드 바이트 수"""
    mp, nbytes = {}, 2
    cs = re.search(rb"begincodespacerange\s*<([0-9A-Fa-f]+)>", text)
    if cs:
        nbytes = max(1, len(cs.group(1)) // 2)

    def u(h):
        b = bytes.fromhex(h.decode())
        try:
            return b.decode("utf-16-be")
        except UnicodeDecodeError:
            return ""
    for block in re.findall(rb"beginbfchar(.*?)endbfchar", text, re.S):
        for a, b in re.findall(rb"<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]*)>", block):
            mp[int(a, 16)] = u(b)
    for block in re.findall(rb"beginbfrange(.*?)endbfrange", text, re.S):
        for a, b, rest in re.findall(rb"<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(<[0-9A-Fa-f]+>|\[[^\]]*\])", block):
            lo, hi = int(a, 16), int(b, 16)
            if rest.startswith(b"["):
                for k, h in enumerate(re.findall(rb"<([0-9A-Fa-f]+)>", rest)):
                    mp[lo + k] = u(h)
            else:
                base = int(rest[1:-1], 16)
                width = len(rest) - 2
                for k in range(hi - lo + 1):
                    mp[lo + k] = u(format(base + k, f"0{width}X").encode())
    return mp, nbytes


_TOK = re.compile(rb"\s*(<<|>>|<[0-9A-Fa-f\s]*>|\((?:\\.|[^\\()]|\((?:\\.|[^\\()])*\))*\)|\[|\]|/[^\s/\[\]()<>{}%]*|[-+]?\d*\.?\d+|[A-Za-z'\"*]+|%[^\n]*)", re.S)


def _literal(b):
    out, i = bytearray(), 1
    esc = {b"n": b"\n", b"r": b"\r", b"t": b"\t", b"b": b"\b", b"f": b"\f", b"(": b"(", b")": b")", b"\\": b"\\"}
    while i < len(b) - 1:
        c = b[i:i + 1]
        if c == b"\\":
            n = b[i + 1:i + 2]
            if n in esc:
                out += esc[n]; i += 2; continue
            m = re.match(rb"[0-7]{1,3}", b[i + 1:i + 4])
            if m:
                out.append(int(m.group(), 8) & 255); i += 1 + len(m.group()); continue
            i += 2; continue
        out += c; i += 1
    return bytes(out)


def _glyphs(raw, font):
    """문자열 → [(문자, 폭/1000)]"""
    mp, nb, widths, dw = font
    out = []
    for i in range(0, len(raw) - nb + 1, nb):
        code = int.from_bytes(raw[i:i + nb], "big")
        ch = mp.get(code, "") if mp else bytes([code]).decode("latin-1") if nb == 1 else ""
        out.append((ch, widths.get(code, dw) / 1000.0))
    return out


def _widths(fb, objs):
    """CID 폰트의 /W 또는 단순 폰트의 /Widths → {코드: 폭}"""
    widths, dw = {}, 1000.0
    desc = fb
    m = re.search(rb"/DescendantFonts\s*\[\s*(\d+)\s+0\s+R", fb)
    if m and int(m.group(1)) in objs:
        desc = objs[int(m.group(1))]
    mdw = re.search(rb"/DW\s+([\d.]+)", desc)
    if mdw:
        dw = float(mdw.group(1))
    w = None
    mw = re.search(rb"/W\s*(\[(?:[^\[\]]|\[[^\]]*\])*\])", desc)
    if mw:
        w = mw.group(1)
    else:
        r = re.search(rb"/W\s+(\d+)\s+0\s+R", desc)
        if r and int(r.group(1)) in objs:
            w = objs[int(r.group(1))]
    if w:
        toks = re.findall(rb"\[[^\]]*\]|[-\d.]+", w.strip()[1:-1] if w.strip().startswith(b"[") else w)
        i = 0
        while i < len(toks):
            first = int(float(toks[i]))
            if i + 1 < len(toks) and toks[i + 1].startswith(b"["):
                for k, v in enumerate(re.findall(rb"[-\d.]+", toks[i + 1])):
                    widths[first + k] = float(v)
                i += 2
            elif i + 2 < len(toks):
                last, v = int(float(toks[i + 1])), float(toks[i + 2])
                for c in range(first, last + 1):
                    widths[c] = v
                i += 3
            else:
                break
    mf = re.search(rb"/FirstChar\s+(\d+)", fb)
    ws = re.search(rb"/Widths\s*\[([^\]]*)\]", fb)
    if mf and ws:
        for k, v in enumerate(re.findall(rb"[-\d.]+", ws.group(1))):
            widths[int(mf.group(1)) + k] = float(v)
        dw = 500.0
    return widths, dw


def _page_text(content, fonts):
    words = []  # (y, x, text, size)
    font = ({}, 1, {}, 1000.0)
    fsize = 10.0
    tm = [1.0, 0, 0, 1.0, 0, 0]
    line_start = [0.0, 0.0]
    leading = 0.0
    adv = 0.0  # 현재 Tm 기준 텍스트 공간 진행량
    stack = []
    ctm = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0]
    gstack = []
    word, word_x, word_end = [], None, None

    def dev(x, y):
        a, b, c, d, e, f = ctm
        return a * x + c * y + e, b * x + d * y + f

    def end_word():
        nonlocal word, word_x, word_end
        if word and word_x is not None:
            X, Y = dev(word_x, tm[5])
            Xe, _ = dev(word_end, tm[5])
            size = abs(fsize * (tm[3] or 1) * (ctm[3] or 1))
            words.append((Y, min(X, Xe), "".join(word), size, max(X, Xe)))
        word, word_x, word_end = [], None, None

    def show(raw):
        nonlocal adv, word_x, word_end
        for ch, w in _glyphs(raw, font):
            x = tm[4] + adv * tm[0]
            if ch.strip():
                if word_x is None:
                    word_x = x
                word.append(ch)
                word_end = x + w * fsize * tm[0]
            else:
                end_word()
            adv += w * fsize

    def gap(v):
        nonlocal adv
        if v < -200:
            end_word()
        adv += -v / 1000.0 * fsize

    def move(x, y):
        nonlocal adv
        end_word()
        tm[4], tm[5] = x, y
        adv = 0.0

    for m in _TOK.finditer(content):
        t = m.group(1)
        if not t or t.startswith(b"%"):
            continue
        if t[:1] == b"<" and t != b"<<":
            hx = re.sub(rb"\s", b"", t[1:-1])
            if len(hx) % 2:
                hx += b"0"
            stack.append(("str", bytes.fromhex(hx.decode())))
        elif t[:1] == b"(":
            stack.append(("str", _literal(t)))
        elif t == b"[":
            stack.append(("[", None))
        elif t == b"]":
            arr = []
            while stack and stack[-1][0] != "[":
                arr.append(stack.pop())
            if stack:
                stack.pop()
            stack.append(("arr", list(reversed(arr))))
        elif t[:1] == b"/":
            stack.append(("name", t[1:]))
        elif re.fullmatch(rb"[-+]?\d*\.?\d+", t):
            stack.append(("num", float(t)))
        else:
            op, args, stack = t, stack, []
            nums = [a[1] for a in args if a[0] == "num"]
            if op == b"q":
                end_word(); gstack.append(ctm[:])
            elif op == b"Q":
                end_word()
                if gstack:
                    ctm = gstack.pop()
            elif op == b"cm" and len(nums) >= 6:
                end_word()
                a2, b2, c2, d2, e2, f2 = nums[-6:]
                a1, b1, c1, d1, e1, f1 = ctm
                ctm = [a2 * a1 + b2 * c1, a2 * b1 + b2 * d1, c2 * a1 + d2 * c1, c2 * b1 + d2 * d1, e2 * a1 + f2 * c1 + e1, e2 * b1 + f2 * d1 + f1]
            elif op == b"BT":
                tm[:] = [1.0, 0, 0, 1.0, 0, 0]; line_start = [0.0, 0.0]; adv = 0.0
            elif op == b"ET":
                end_word()
            elif op == b"Tf":
                names = [a[1] for a in args if a[0] == "name"]
                if names:
                    font = fonts.get(names[-1], ({}, 1, {}, 1000.0))
                if nums:
                    fsize = nums[-1]
            elif op == b"Tm" and len(nums) >= 6:
                end_word()
                tm[:] = nums[-6:]; line_start = [tm[4], tm[5]]; adv = 0.0
            elif op in (b"Td", b"TD") and len(nums) >= 2:
                if op == b"TD":
                    leading = -nums[-1]
                line_start = [line_start[0] + nums[-2] * tm[0] + nums[-1] * tm[2], line_start[1] + nums[-2] * tm[1] + nums[-1] * tm[3]]
                move(*line_start)
            elif op == b"TL" and nums:
                leading = nums[-1]
            elif op in (b"T*", b"'", b'"'):
                line_start = [line_start[0] - leading * tm[2], line_start[1] - leading * tm[3]]
                move(*line_start)
                if op != b"T*":
                    for a in args:
                        if a[0] == "str":
                            show(a[1])
            elif op == b"Tj":
                for a in args:
                    if a[0] == "str":
                        show(a[1])
            elif op == b"TJ":
                for a in args:
                    if a[0] != "arr":
                        continue
                    for kind, v in a[1]:
                        if kind == "str":
                            show(v)
                        elif kind == "num":
                            gap(v)
    end_word()
    if not words:
        return []
    # 기기 좌표에서 위→아래(y 큰 쪽 먼저)로 줄을 묶고, 줄 안에서는 x 순으로 잇는다.
    # 단어 사이 실제 간격이 글자 크기의 0.15 배보다 작으면 붙여 쓴다(글자 단위 배치 PDF 대응).
    rows = []
    for y, x, txt, size, xe in sorted(words, key=lambda w: (-w[0], w[1])):
        tol = max(1.0, size * 0.35)
        if rows and abs(rows[-1][0] - y) <= tol:
            rows[-1][1].append((x, txt, size, xe))
        else:
            rows.append([y, [(x, txt, size, xe)]])
    lines = []
    for _, cells in rows:
        cells.sort()
        out, prev_end = "", None
        for x, txt, size, xe in cells:
            if prev_end is not None and x - prev_end > size * 0.15:
                out += " "
            out += txt
            prev_end = xe if prev_end is None else max(prev_end, xe)
        lines.append(out)
    return lines


def extract_text(data):
    if b"/Encrypt" in data:
        raise PdfTextError("암호화된 PDF 는 내장 추출기로 읽을 수 없습니다")
    objs = _objects(data)
    if not objs:
        raise PdfTextError("PDF 객체를 찾지 못했습니다")
    if any(b"/ObjStm" in b for b in objs.values()):
        raise PdfTextError("압축 객체 스트림(ObjStm)을 쓰는 PDF 는 내장 추출기로 읽을 수 없습니다 (pypdf 설치 필요)")
    pages = [n for n, b in objs.items() if re.search(rb"/Type\s*/Page(?!s)", b)]
    # 페이지 순서: /Kids 순서를 따른다
    order = []
    for b in objs.values():
        if re.search(rb"/Type\s*/Pages", b):
            order += _refs_list(b, b"Kids")
    pages = [p for p in order if p in pages] or sorted(pages)
    out = []
    for pn in pages:
        pb = objs[pn]
        res = pb
        rr = _ref(pb, b"Resources")
        if rr and rr in objs:
            res = objs[rr]
        fonts = {}
        fm = re.search(rb"/Font\s*<<(.*?)>>", res, re.S)
        fdict = fm.group(1) if fm else b""
        if not fm:
            fr = _ref(res, b"Font")
            fdict = objs.get(fr, b"") if fr else b""
        for name, num in re.findall(rb"/([^\s/]+)\s+(\d+)\s+0\s+R", fdict):
            fb = objs.get(int(num), b"")
            tu = _ref(fb, b"ToUnicode")
            widths, dw = _widths(fb, objs)
            if tu and tu in objs:
                mp, nb = _cmap(_stream(objs[tu]) or b"")
            else:
                mp, nb = {}, (2 if b"/Type0" in fb else 1)
            fonts[name] = (mp, nb, widths, dw)
        content = b""
        for c in _refs_list(pb, b"Contents"):
            if c in objs:
                content += (_stream(objs[c]) or b"") + b"\n"
        out.append("\n".join(_page_text(content, fonts)))
    text = "\n\n".join(out)
    if not text.strip():
        raise PdfTextError("텍스트가 없는 PDF 입니다 (스캔 이미지라면 OCR 이 필요합니다)")
    return text


if __name__ == "__main__":
    import sys
    with open(sys.argv[1], "rb") as f:
        print(extract_text(f.read()))
