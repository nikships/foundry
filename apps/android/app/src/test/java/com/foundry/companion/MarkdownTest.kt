package com.foundry.companion

import com.foundry.companion.util.MarkdownBlock
import com.foundry.companion.util.MarkdownInline
import com.foundry.companion.util.parseInline
import com.foundry.companion.util.parseMarkdown
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class MarkdownTest {

    @Test
    fun testParagraphsAndHeadings() {
        val blocks = parseMarkdown("first line\nsecond line\n\n## Plan\nbody")
        assertEquals(3, blocks.size)
        val first = blocks[0] as MarkdownBlock.Paragraph
        assertEquals("first line\nsecond line", (first.children.single() as MarkdownInline.Text).text)
        val heading = blocks[1] as MarkdownBlock.Heading
        assertEquals(2, heading.level)
        assertEquals("Plan", (heading.children.single() as MarkdownInline.Text).text)
    }

    @Test
    fun testFencedCodeStaysLiteral() {
        val blocks = parseMarkdown("```ts\nconst a = \"**not bold**\";\n```")
        assertEquals(
            listOf(MarkdownBlock.Code(language = "ts", text = "const a = \"**not bold**\";")),
            blocks
        )
    }

    @Test
    fun testUnterminatedFenceKeepsBody() {
        val blocks = parseMarkdown("```\nstill code")
        assertEquals(listOf(MarkdownBlock.Code(language = "", text = "still code")), blocks)
    }

    @Test
    fun testListsQuotesAndRules() {
        val blocks = parseMarkdown("- one\n- two\n\n1. first\n\n> quoted\n> more\n\n---")
        assertTrue(blocks[0] is MarkdownBlock.ListBlock && !(blocks[0] as MarkdownBlock.ListBlock).ordered)
        assertTrue(blocks[1] is MarkdownBlock.ListBlock && (blocks[1] as MarkdownBlock.ListBlock).ordered)
        assertEquals(
            MarkdownBlock.Quote(listOf(MarkdownInline.Text("quoted\nmore"))),
            blocks[2]
        )
        assertEquals(MarkdownBlock.Rule, blocks[3])
    }

    @Test
    fun testInlineMarksAndSafeLinks() {
        assertEquals(
            listOf(
                MarkdownInline.Strong(listOf(MarkdownInline.Text("bold"))),
                MarkdownInline.Text(" and "),
                MarkdownInline.Em(listOf(MarkdownInline.Text("em"))),
                MarkdownInline.Text(" and "),
                MarkdownInline.Code("code")
            ),
            parseInline("**bold** and *em* and `code`")
        )
        assertEquals(
            listOf(MarkdownInline.Link("https://example.com/a", listOf(MarkdownInline.Text("docs")))),
            parseInline("[docs](https://example.com/a)")
        )
        assertEquals(
            listOf(MarkdownInline.Text("[x](javascript:alert(1))")),
            parseInline("[x](javascript:alert(1))")
        )
        assertEquals(
            listOf(MarkdownInline.Text("a_b_c and snake_case_name")),
            parseInline("a_b_c and snake_case_name")
        )
    }
}
