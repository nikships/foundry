package com.foundry.companion.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.foundry.companion.ui.theme.FoundryTheme
import com.foundry.companion.ui.theme.GeistMonoFontFamily
import com.foundry.companion.util.CustomTabs
import com.foundry.companion.util.MarkdownBlock
import com.foundry.companion.util.MarkdownInline
import com.foundry.companion.util.parseMarkdown

/**
 * Renders the desktop Smith Markdown grammar as Compose. Links open in a
 * Custom Tab; nothing is parsed as HTML.
 */
@Composable
fun MarkdownText(
    text: String,
    modifier: Modifier = Modifier
) {
    val blocks = remember(text) { parseMarkdown(text) }
    Column(
        modifier = modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        blocks.forEach { block ->
            MarkdownBlockView(block = block)
        }
    }
}

@Composable
private fun MarkdownBlockView(block: MarkdownBlock) {
    val colors = FoundryTheme.colors
    val typography = FoundryTheme.typography
    val shapes = FoundryTheme.shapes
    val context = LocalContext.current

    when (block) {
        is MarkdownBlock.Heading -> {
            val size = when (block.level.coerceAtMost(4)) {
                1 -> 18.sp
                2 -> 16.sp
                3 -> 15.sp
                else -> 14.sp
            }
            Text(
                text = inlineAnnotated(block.children) { CustomTabs.open(context, it) },
                style = typography.bodyStrong.copy(fontSize = size, lineHeight = (size.value + 6).sp),
                color = colors.textPrimary,
                modifier = Modifier.semantics { heading() }
            )
        }
        is MarkdownBlock.Code -> {
            Text(
                text = block.text,
                style = typography.transcriptMono,
                color = colors.textPrimary,
                modifier = Modifier
                    .fillMaxWidth()
                    .background(colors.bgInput, shapes.card)
                    .border(1.dp, colors.line, shapes.card)
                    .padding(10.dp)
                    .semantics { contentDescription = "Code block" }
            )
        }
        is MarkdownBlock.ListBlock -> {
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                block.items.forEachIndexed { index, item ->
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(
                            text = if (block.ordered) "${index + 1}." else "•",
                            style = typography.body,
                            color = colors.textDim,
                            modifier = Modifier.width(20.dp)
                        )
                        Text(
                            text = inlineAnnotated(item) { CustomTabs.open(context, it) },
                            style = typography.body,
                            color = colors.textPrimary,
                            modifier = Modifier.weight(1f)
                        )
                    }
                }
            }
        }
        is MarkdownBlock.Quote -> {
            Text(
                text = inlineAnnotated(block.children) { CustomTabs.open(context, it) },
                style = typography.body.copy(fontStyle = FontStyle.Italic),
                color = colors.textDim,
                modifier = Modifier
                    .fillMaxWidth()
                    .border(width = 0.dp, color = colors.line, shape = shapes.card)
                    .padding(start = 10.dp)
                    .background(colors.bgRaised, shapes.card)
                    .padding(10.dp)
            )
        }
        MarkdownBlock.Rule -> {
            HorizontalDivider(color = colors.line, thickness = 1.dp)
        }
        is MarkdownBlock.Paragraph -> {
            Text(
                text = inlineAnnotated(block.children) { CustomTabs.open(context, it) },
                style = typography.body,
                color = colors.textPrimary
            )
        }
    }
}

private fun inlineAnnotated(
    nodes: List<MarkdownInline>,
    onOpen: (String) -> Unit
) = buildAnnotatedString {
    fun appendNodes(items: List<MarkdownInline>) {
        items.forEach { node ->
            when (node) {
                is MarkdownInline.Text -> append(node.text)
                is MarkdownInline.Code -> {
                    pushStyle(
                        SpanStyle(
                            fontFamily = GeistMonoFontFamily,
                            fontWeight = FontWeight.Medium,
                            background = androidx.compose.ui.graphics.Color(0x17FFFFFF)
                        )
                    )
                    append(node.text)
                    pop()
                }
                is MarkdownInline.Strong -> {
                    pushStyle(SpanStyle(fontWeight = FontWeight.SemiBold))
                    appendNodes(node.children)
                    pop()
                }
                is MarkdownInline.Em -> {
                    pushStyle(SpanStyle(fontStyle = FontStyle.Italic))
                    appendNodes(node.children)
                    pop()
                }
                is MarkdownInline.Link -> {
                    withLink(
                        LinkAnnotation.Clickable(
                            tag = node.href,
                            styles = TextLinkStyles(
                                style = SpanStyle(
                                    color = androidx.compose.ui.graphics.Color(0xFFEE6018),
                                    textDecoration = TextDecoration.Underline
                                )
                            ),
                            linkInteractionListener = { onOpen(node.href) }
                        )
                    ) {
                        appendNodes(node.children)
                    }
                }
            }
        }
    }
    appendNodes(nodes)
}
