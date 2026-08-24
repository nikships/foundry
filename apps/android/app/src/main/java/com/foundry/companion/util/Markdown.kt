package com.foundry.companion.util

/**
 * The same small chat Markdown grammar the desktop transcript uses. Smith's
 * replies arrive as Markdown; this turns them into a block/inline tree a
 * Compose renderer can paint — no HTML, no extra dependency. Anything outside
 * the grammar stays literal text.
 *
 * Covered: paragraphs, ATX headings, fenced code, unordered/ordered lists,
 * blockquotes, rules, bold, italic, inline code, and http(s) links.
 */
sealed interface MarkdownInline {
    data class Text(val text: String) : MarkdownInline
    data class Code(val text: String) : MarkdownInline
    data class Strong(val children: List<MarkdownInline>) : MarkdownInline
    data class Em(val children: List<MarkdownInline>) : MarkdownInline
    data class Link(val href: String, val children: List<MarkdownInline>) : MarkdownInline
}

sealed interface MarkdownBlock {
    data class Paragraph(val children: List<MarkdownInline>) : MarkdownBlock
    data class Heading(val level: Int, val children: List<MarkdownInline>) : MarkdownBlock
    data class Code(val language: String, val text: String) : MarkdownBlock
    data class ListBlock(val ordered: Boolean, val items: List<List<MarkdownInline>>) : MarkdownBlock
    data class Quote(val children: List<MarkdownInline>) : MarkdownBlock
    data object Rule : MarkdownBlock
}

private val FENCE = Regex("""^```(\S*)\s*$""")
private val HEADING = Regex("""^(#{1,6})\s+(.*)$""")
private val RULE = Regex("""^(?:-{3,}|\*{3,}|_{3,})\s*$""")
private val BULLET_ITEM = Regex("""^\s*[-*+]\s+(.*)$""")
private val ORDERED_ITEM = Regex("""^\s*\d+[.)]\s+(.*)$""")
private val QUOTE_LINE = Regex("""^>\s?(.*)$""")
private val CLOSING_FENCE = Regex("""^```\s*$""")

private val INLINE_CODE = Regex("""^`([^`]+)`""")
private val STRONG = Regex("""^\*\*((?:[^*]|\*(?!\*))+)\*\*""")
private val EM_STAR = Regex("""^\*([^*\s](?:[^*]*[^*\s])?)\*""")
private val EM_UNDERSCORE = Regex("""^_([^_\s](?:[^_]*[^_\s])?)_""")
private val LINK = Regex("""^\[([^\]]+)]\((https?://[^)\s]+)\)""")
private val BARE_URL = Regex("""^https?://[^\s<>)]+""")

private fun isStructural(line: String): Boolean =
    FENCE.matches(line) ||
        HEADING.matches(line) ||
        RULE.matches(line.trim()) ||
        BULLET_ITEM.matches(line) ||
        ORDERED_ITEM.matches(line) ||
        QUOTE_LINE.matches(line)

fun parseMarkdown(source: String): List<MarkdownBlock> {
    val lines = source.replace("\r\n", "\n").split('\n')
    val blocks = mutableListOf<MarkdownBlock>()
    var i = 0

    while (i < lines.size) {
        val line = lines[i]
        if (line.trim().isEmpty()) {
            i += 1
            continue
        }

        val fence = FENCE.matchEntire(line)
        if (fence != null) {
            val body = mutableListOf<String>()
            i += 1
            while (i < lines.size && !CLOSING_FENCE.matches(lines[i])) {
                body.add(lines[i])
                i += 1
            }
            i += 1
            blocks.add(MarkdownBlock.Code(language = fence.groupValues[1], text = body.joinToString("\n")))
            continue
        }

        val heading = HEADING.matchEntire(line)
        if (heading != null) {
            blocks.add(
                MarkdownBlock.Heading(
                    level = heading.groupValues[1].length,
                    children = parseInline(heading.groupValues[2])
                )
            )
            i += 1
            continue
        }

        if (RULE.matches(line.trim())) {
            blocks.add(MarkdownBlock.Rule)
            i += 1
            continue
        }

        val ordered = ORDERED_ITEM.matches(line)
        if (ordered || BULLET_ITEM.matches(line)) {
            val itemPattern = if (ordered) ORDERED_ITEM else BULLET_ITEM
            val items = mutableListOf<List<MarkdownInline>>()
            while (i < lines.size) {
                val item = itemPattern.matchEntire(lines[i]) ?: break
                items.add(parseInline(item.groupValues[1]))
                i += 1
            }
            blocks.add(MarkdownBlock.ListBlock(ordered = ordered, items = items))
            continue
        }

        if (QUOTE_LINE.matches(line)) {
            val body = mutableListOf<String>()
            while (i < lines.size) {
                val quoted = QUOTE_LINE.matchEntire(lines[i]) ?: break
                body.add(quoted.groupValues[1])
                i += 1
            }
            blocks.add(MarkdownBlock.Quote(children = parseInline(body.joinToString("\n"))))
            continue
        }

        val body = mutableListOf<String>()
        while (i < lines.size && lines[i].trim().isNotEmpty() && !isStructural(lines[i])) {
            body.add(lines[i])
            i += 1
        }
        blocks.add(MarkdownBlock.Paragraph(children = parseInline(body.joinToString("\n"))))
    }

    return blocks
}

fun parseInline(text: String, noLinks: Boolean = false): List<MarkdownInline> {
    val out = mutableListOf<MarkdownInline>()
    val plain = StringBuilder()
    fun flush() {
        if (plain.isNotEmpty()) {
            out.add(MarkdownInline.Text(plain.toString()))
            plain.clear()
        }
    }

    var rest = text
    while (rest.isNotEmpty()) {
        val code = INLINE_CODE.find(rest)
        if (code != null && code.range.first == 0) {
            flush()
            out.add(MarkdownInline.Code(code.groupValues[1]))
            rest = rest.substring(code.value.length)
            continue
        }
        val strong = STRONG.find(rest)
        if (strong != null && strong.range.first == 0) {
            flush()
            out.add(MarkdownInline.Strong(parseInline(strong.groupValues[1], noLinks)))
            rest = rest.substring(strong.value.length)
            continue
        }
        val afterWord = plain.isNotEmpty() && plain.last().isLetterOrDigit()
        val emStar = EM_STAR.find(rest)?.takeIf { it.range.first == 0 }
        val emUnder = if (afterWord) null else EM_UNDERSCORE.find(rest)?.takeIf { it.range.first == 0 }
        val em = emStar ?: emUnder
        if (em != null) {
            flush()
            out.add(MarkdownInline.Em(parseInline(em.groupValues[1], noLinks)))
            rest = rest.substring(em.value.length)
            continue
        }
        val link = if (noLinks) null else LINK.find(rest)?.takeIf { it.range.first == 0 }
        if (link != null) {
            flush()
            out.add(
                MarkdownInline.Link(
                    href = link.groupValues[2],
                    children = parseInline(link.groupValues[1], noLinks = true)
                )
            )
            rest = rest.substring(link.value.length)
            continue
        }
        val bare = if (noLinks) null else BARE_URL.find(rest)?.takeIf { it.range.first == 0 }
        if (bare != null) {
            flush()
            val href = bare.value.replace(Regex("""[.,;:!?]+$"""), "")
            out.add(MarkdownInline.Link(href = href, children = listOf(MarkdownInline.Text(href))))
            rest = rest.substring(href.length)
            continue
        }
        plain.append(rest[0])
        rest = rest.substring(1)
    }
    flush()
    return out
}
