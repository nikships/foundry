package com.foundry.companion.ui.screens.smith

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.foundry.companion.data.model.booleanOrNull
import com.foundry.companion.data.model.intOrNull
import com.foundry.companion.data.model.longOrNull
import com.foundry.companion.data.model.objList
import com.foundry.companion.data.model.objOrNull
import com.foundry.companion.data.model.prettyJson
import com.foundry.companion.data.model.stringList
import com.foundry.companion.data.model.stringOr
import com.foundry.companion.data.model.stringOrNull
import com.foundry.companion.ui.components.MarkdownText
import com.foundry.companion.ui.components.StatusBadge
import com.foundry.companion.ui.theme.FoundryTheme
import com.foundry.companion.util.CustomTabs
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull


private val ARTIFACT_KIND_LABEL = mapOf(
    "pipeline_design" to "pipeline design",
    "agent_design" to "agent design",
    "envelope_design" to "report design",
    "checklist" to "checklist",
    "run_summary" to "run summary",
    "entity_comparison" to "entity comparison",
    "change_receipt" to "change receipt",
    "project_card" to "project card",
    "pr_card" to "pull request",
    "settings_diff" to "settings diff",
    "diagnostics" to "diagnostics",
    "data_table" to "data catalog",
    "evidence_disclosure" to "context & evidence",
    "engineer_checkpoint" to "engineer checkpoint",
    "readiness_journey" to "readiness journey",
    "provider_status" to "provider status",
    "action_receipt" to "action receipt"
)

@Composable
fun SmithArtifactCard(
    artifact: JsonObject,
    modifier: Modifier = Modifier,
    onOpenUrl: ((String) -> Unit)? = null
) {
    val colors = FoundryTheme.colors
    val typography = FoundryTheme.typography
    val shapes = FoundryTheme.shapes
    val context = LocalContext.current
    val openUrl = onOpenUrl ?: { CustomTabs.open(context, it) }
    val kind = artifact.stringOr("kind")
    val version = artifact.intOrNull("version") ?: 1
    val known = kind in ARTIFACT_KIND_LABEL && version == 1
    val title = artifactTitle(artifact)
    val rationale = artifact.stringOrNull("rationale").orEmpty()
    val warnings = artifact.objList("warnings")

    Column(
        modifier = modifier
            .fillMaxWidth()
            .background(colors.bgPanel, shapes.card)
            .border(1.dp, colors.lineStrong, shapes.card)
            .padding(12.dp)
            .semantics { contentDescription = "Smith ${ARTIFACT_KIND_LABEL[kind] ?: "card"}" },
        verticalArrangement = Arrangement.spacedBy(10.dp)
    ) {
        Text(
            text = (ARTIFACT_KIND_LABEL[kind] ?: kind.replace('_', ' ')).uppercase(),
            style = typography.eyebrowMono,
            color = colors.accent
        )
        if (title.isNotBlank()) {
            Text(text = title, style = typography.bodyStrong, color = colors.textPrimary)
        }
        if (rationale.isNotBlank()) {
            MarkdownText(text = rationale)
        }
        if (!known) {
            Text(
                text = "This card needs a newer Foundry to render fully.",
                style = typography.metaMono,
                color = colors.textDim
            )
        } else {
            ArtifactBody(kind = kind, artifact = artifact, onOpenUrl = openUrl)
        }
        warnings.forEach { warning ->
            Text(
                text = warning.stringOr("message").ifBlank { warning.toString() },
                style = typography.metaMono,
                color = colors.statusWarning
            )
        }
        JsonDisclosure(value = artifact)
    }
}

@Composable
private fun ArtifactBody(kind: String, artifact: JsonObject, onOpenUrl: (String) -> Unit) {
    when (kind) {
        "pipeline_design" -> PipelineBody(artifact.objOrNull("pipeline"))
        "agent_design" -> AgentBody(artifact.objOrNull("agent"))
        "envelope_design" -> EnvelopeBody(artifact)
        "checklist" -> ChecklistBody(artifact.objOrNull("checklist"))
        "run_summary" -> RunSummaryBody(artifact, onOpenUrl)
        "entity_comparison" -> ComparisonBody(artifact)
        "change_receipt" -> ChangeReceiptBody(artifact.objOrNull("receipt"))
        "project_card" -> ProjectBody(artifact.objOrNull("project"), onOpenUrl)
        "pr_card" -> PrBody(artifact.objOrNull("pr"), onOpenUrl)
        "settings_diff" -> SettingsDiffBody(artifact.objOrNull("diff"))
        "diagnostics" -> DiagnosticsBody(artifact.objOrNull("diagnostics"))
        "data_table" -> DataTableBody(artifact.objOrNull("table"))
        "evidence_disclosure" -> EvidenceBody(artifact.objOrNull("evidence"))
        "engineer_checkpoint" -> CheckpointBody(artifact.objOrNull("checkpoint"))
        "readiness_journey" -> ReadinessBody(artifact.objOrNull("journey"), onOpenUrl)
        "provider_status" -> ProviderBody(artifact.objOrNull("status"))
        "action_receipt" -> ActionReceiptBody(artifact.objOrNull("receipt"), onOpenUrl)
    }
}

@Composable
private fun PipelineBody(pipeline: JsonObject?) {
    if (pipeline == null) return
    MetaRow("ID", pipeline.stringOr("id"))
    MetaRow("Name", pipeline.stringOr("name"))
    pipeline.stringOrNull("description")?.let { MarkdownText(text = it) }
    pipeline.objList("phases").forEachIndexed { index, phase ->
        LabeledBlock(
            title = "${index + 1}. ${phase.stringOr("name").ifBlank { "Phase" }}",
            detail = listOfNotNull(
                phase.stringOrNull("kind"),
                phase.stringOrNull("agent"),
                phase.stringOrNull("description")
            ).joinToString(" · ")
        )
    }
}

@Composable
private fun AgentBody(agent: JsonObject?) {
    if (agent == null) return
    MetaRow("Name", agent.stringOr("name"))
    MetaRow("Model", agent.stringOr("model"))
    MetaRow("Envelope", agent.stringOr("envelope"))
    agent.stringOrNull("purpose")?.let { MarkdownText(text = it) }
    agent.stringOrNull("systemPrompt")?.let { LabeledMarkdown("System prompt", it) }
    agent.stringOrNull("userPrompt")?.let { LabeledMarkdown("User prompt", it) }
}

@Composable
private fun EnvelopeBody(artifact: JsonObject) {
    val envelope = artifact.objOrNull("envelope") ?: return
    MetaRow("Name", envelope.stringOr("name"))
    envelope.stringOrNull("description")?.let { MarkdownText(text = it) }
    envelope.objList("fields").forEach { field ->
        MetaRow(field.stringOr("name").ifBlank { "field" }, field.stringOr("type").ifBlank { "any" })
    }
    artifact.objOrNull("sampleOutput")?.let { Disclosure("Sample output", it.prettyJson()) }
}

@Composable
private fun ChecklistBody(checklist: JsonObject?) {
    if (checklist == null) return
    checklist.stringOrNull("summary")?.let { MarkdownText(text = it) }
    checklist.objList("items").forEach { item ->
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.Top
        ) {
            StatusBadge(status = item.stringOr("status", "info"), customLabel = item.stringOr("status", "info"))
            Column(verticalArrangement = Arrangement.spacedBy(2.dp), modifier = Modifier.weight(1f)) {
                Text(
                    text = item.stringOr("label"),
                    style = FoundryTheme.typography.bodyStrong,
                    color = FoundryTheme.colors.textPrimary
                )
                item.stringOrNull("detail")?.let {
                    Text(text = it, style = FoundryTheme.typography.body, color = FoundryTheme.colors.textDim)
                }
                item.stringOrNull("fix")?.let {
                    Text(text = "Fix: $it", style = FoundryTheme.typography.metaMono, color = FoundryTheme.colors.statusWarning)
                }
                item.stringOrNull("evidence")?.let { Disclosure("Evidence", it) }
            }
        }
    }
}

@Composable
private fun RunSummaryBody(artifact: JsonObject, onOpenUrl: (String) -> Unit) {
    StatusBadge(status = artifact.stringOr("status"))
    MetaRow("Run", artifact.stringOr("runId"))
    MetaRow("Pipeline", artifact.stringOr("pipelineName").ifBlank { artifact.stringOr("pipelineId") })
    artifact.stringOrNull("request")?.let { MarkdownText(text = it) }
    artifact.stringOrNull("outcomeDetail")?.let {
        Text(text = it, style = FoundryTheme.typography.body, color = FoundryTheme.colors.textDim)
    }
    artifact.objList("phases").forEach { phase ->
        LabeledBlock(
            title = phase.stringOr("name"),
            detail = listOfNotNull(phase.stringOrNull("kind"), phase.stringOrNull("status"), phase.stringOrNull("error")).joinToString(" · ")
        )
    }
    artifact.stringOrNull("prUrl")?.let { LinkRow("Open PR", it, onOpenUrl) }
    artifact.stringOrNull("issueUrl")?.let { LinkRow("Open issue", it, onOpenUrl) }
}

@Composable
private fun ComparisonBody(artifact: JsonObject) {
    MetaRow("Entity", "${artifact.stringOr("entityKind")} · ${artifact.stringOr("name")}")
    artifact.objOrNull("before")?.let { Disclosure("Before", it.prettyJson()) }
    artifact.objOrNull("after")?.let { Disclosure("After", it.prettyJson()) }
}

@Composable
private fun ChangeReceiptBody(receipt: JsonObject?) {
    if (receipt == null) return
    StatusBadge(status = receipt.stringOr("status"), customLabel = receipt.stringOr("status"))
    MetaRow("Target", receipt.stringOr("target").replace('_', ' '))
    receipt.stringOrNull("summary")?.let { MarkdownText(text = it) }
    val files = receipt.stringList("filesChanged")
    if (files.isNotEmpty()) {
        Disclosure("Files", files.joinToString("\n"))
    }
    receipt.stringOrNull("diffstat")?.let { Disclosure("Diffstat", it) }
    receipt.objOrNull("command")?.let { command ->
        MetaRow("Command", command.stringOr("command"))
        MetaRow("Exit", command.intOrNull("exitCode")?.toString() ?: "—")
    }
    receipt.stringOrNull("outputExcerpt")?.let { Disclosure("Output", it) }
}

@Composable
private fun ProjectBody(project: JsonObject?, onOpenUrl: (String) -> Unit) {
    if (project == null) return
    MetaRow("Path", project.stringOr("path"))
    MetaRow("Base", project.stringOr("baseRef"))
    project.stringOrNull("summary")?.let { MarkdownText(text = it) }
    project.objOrNull("github")?.stringOrNull("repo")?.let { MetaRow("GitHub", it) }
    project.objOrNull("health")?.stringOrNull("summary")?.let { MetaRow("Health", it) }
    project.objOrNull("divergence")?.let { div ->
        MetaRow("Sync", "${div.stringOr("state")} · +${div.intOrNull("ahead") ?: 0} / -${div.intOrNull("behind") ?: 0}")
    }
}

@Composable
private fun PrBody(pr: JsonObject?, onOpenUrl: (String) -> Unit) {
    if (pr == null) return
    MetaRow("Branches", listOfNotNull(pr.stringOrNull("headRefName"), pr.stringOrNull("baseRefName")).joinToString(" → "))
    pr.stringOrNull("body")?.let { MarkdownText(text = it) }
    pr.stringOrNull("mergeable")?.let { MetaRow("Mergeable", it) }
    pr.stringOrNull("url")?.let { LinkRow("Open PR", it, onOpenUrl) }
}

@Composable
private fun SettingsDiffBody(diff: JsonObject?) {
    if (diff == null) return
    diff.stringOrNull("summary")?.let { MarkdownText(text = it) }
    diff.objList("sections").forEach { section ->
        Text(
            text = section.stringOr("label").ifBlank { section.stringOr("section") }.uppercase(),
            style = FoundryTheme.typography.eyebrowMono,
            color = FoundryTheme.colors.textDim
        )
        section.objList("changes").forEach { change ->
            MetaRow(
                change.stringOr("label").ifBlank { change.stringOr("key") },
                "${stringify(change["previous"])} → ${stringify(change["next"])}"
            )
        }
    }
}

@Composable
private fun DiagnosticsBody(diagnostics: JsonObject?) {
    if (diagnostics == null) return
    diagnostics.stringOrNull("summary")?.let { MarkdownText(text = it) }
    diagnostics.objList("doctor").forEach { check ->
        LabeledBlock(
            title = check.stringOr("label").ifBlank { check.stringOr("id") },
            detail = listOfNotNull(
                if (check.booleanOrNull("ok") == true) "ok" else "fail",
                check.stringOrNull("detail")
            ).joinToString(" · ")
        )
    }
    diagnostics.objList("items").forEach { item ->
        LabeledBlock(title = item.stringOr("label"), detail = item.stringOr("detail"))
    }
    diagnostics.stringOrNull("lifecycleWarning")?.let {
        Text(text = it, style = FoundryTheme.typography.metaMono, color = FoundryTheme.colors.statusWarning)
    }
}

@Composable
private fun DataTableBody(table: JsonObject?) {
    if (table == null) return
    table.stringOrNull("summary")?.let { MarkdownText(text = it) }
    val columns = table.objList("columns")
    val rows = table.objList("rows")
    if (rows.isEmpty()) {
        Text(
            text = table.objOrNull("emptyState")?.stringOr("message").orEmpty().ifBlank { "Nothing to show." },
            style = FoundryTheme.typography.body,
            color = FoundryTheme.colors.textDim
        )
        return
    }
    rows.take(12).forEach { row ->
        val cells = row.objOrNull("cells") ?: JsonObject(emptyMap())
        val line = columns.map { column ->
            val key = column.stringOr("key")
            "${column.stringOr("label").ifBlank { key }} ${stringify(cells[key])}"
        }.joinToString(" · ")
        Text(text = line, style = FoundryTheme.typography.metaMono, color = FoundryTheme.colors.textPrimary)
    }
    val total = table.intOrNull("totalCount") ?: rows.size
    if (total > 12) {
        Text(text = "+${total - 12} more", style = FoundryTheme.typography.metaMono, color = FoundryTheme.colors.textFaint)
    }
}

@Composable
private fun EvidenceBody(evidence: JsonObject?) {
    if (evidence == null) return
    evidence.stringOrNull("summary")?.let { MarkdownText(text = it) }
    evidence.objOrNull("occupancy")?.let { occ ->
        val used = occ.longOrNull("usedTokens")
        val max = occ.longOrNull("maxTokens")
        if (used != null || max != null) {
            MetaRow("Context", listOfNotNull(used?.toString(), max?.let { "/ $it" }).joinToString(" "))
        }
    }
    evidence.objOrNull("phasePrompt")?.let { prompt ->
        prompt.stringOrNull("systemPrompt")?.let { LabeledMarkdown("System prompt", it) }
        prompt.stringOrNull("userPrompt")?.let { LabeledMarkdown("User prompt", it) }
    }
    evidence.objList("items").forEach { item ->
        Disclosure(item.stringOr("label").ifBlank { item.stringOr("kind") }, item.stringOr("content"))
    }
}

@Composable
private fun CheckpointBody(checkpoint: JsonObject?) {
    if (checkpoint == null) return
    MarkdownText(text = checkpoint.stringOr("question"))
    MetaRow("Run", checkpoint.stringOr("runId"))
    checkpoint.stringOrNull("draftAnswer")?.let { Disclosure("Draft answer", it) }
    if (checkpoint.booleanOrNull("answered") == true) {
        StatusBadge(status = checkpoint.stringOr("decision", "info"))
    }
}

@Composable
private fun ReadinessBody(journey: JsonObject?, onOpenUrl: (String) -> Unit) {
    if (journey == null) return
    MetaRow("Phase", journey.stringOr("phase"))
    journey.objOrNull("marker")?.let { marker ->
        StatusBadge(status = if (marker.booleanOrNull("valid") == true) "success" else "failed", customLabel = if (marker.booleanOrNull("valid") == true) "valid" else "invalid")
        marker.stringOrNull("detail")?.let { Text(text = it, style = FoundryTheme.typography.body, color = FoundryTheme.colors.textDim) }
    }
    journey.objList("criteria").forEach { criterion ->
        LabeledBlock(title = criterion.stringOr("id"), detail = criterion.stringOr("status"))
    }
    journey.objOrNull("pr")?.stringOrNull("url")?.let { LinkRow("Open readiness PR", it, onOpenUrl) }
}

@Composable
private fun ProviderBody(status: JsonObject?) {
    if (status == null) return
    status.stringOrNull("summary")?.let { MarkdownText(text = it) }
    status.objList("providers").forEach { provider ->
        LabeledBlock(
            title = provider.stringOr("label").ifBlank { provider.stringOr("id") },
            detail = listOfNotNull(
                provider.stringOrNull("connection"),
                if (provider.booleanOrNull("authenticated") == true) "signed in" else "signed out",
                provider.stringOrNull("error")
            ).joinToString(" · ")
        )
    }
    status.objOrNull("bridge")?.let { bridge ->
        MetaRow("Bridge", if (bridge.booleanOrNull("running") == true) bridge.stringOr("baseUrl").ifBlank { "running" } else "stopped")
    }
    status.objOrNull("companion")?.let { companion ->
        MetaRow("Companion", companion.stringOr("origin").ifBlank { if (companion.booleanOrNull("running") == true) "running" else "stopped" })
    }
}

@Composable
private fun ActionReceiptBody(receipt: JsonObject?, onOpenUrl: (String) -> Unit) {
    if (receipt == null) return
    StatusBadge(
        status = if (receipt.stringOr("outcome") == "succeeded") "success" else "failed",
        customLabel = receipt.stringOr("outcome")
    )
    MetaRow("Operation", receipt.stringOr("operation"))
    MetaRow("Target", receipt.stringOr("target"))
    receipt.stringOrNull("consequences")?.let { MarkdownText(text = it) }
    receipt.stringOrNull("failure")?.let {
        Text(text = it, style = FoundryTheme.typography.body, color = FoundryTheme.colors.statusFailed)
    }
    receipt.objOrNull("link")?.let { link ->
        val url = link.stringOrNull("url")
        if (!url.isNullOrBlank()) LinkRow(link.stringOr("label").ifBlank { "Open" }, url, onOpenUrl)
        else MetaRow(link.stringOr("kind").ifBlank { "Link" }, link.stringOr("label"))
    }
}

@Composable
private fun MetaRow(label: String, value: String) {
    if (value.isBlank()) return
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        Text(
            text = label.uppercase(),
            style = FoundryTheme.typography.eyebrowMono,
            color = FoundryTheme.colors.textFaint,
            modifier = Modifier.weight(0.35f)
        )
        Text(
            text = value,
            style = FoundryTheme.typography.body,
            color = FoundryTheme.colors.textPrimary,
            modifier = Modifier.weight(0.65f)
        )
    }
}

@Composable
private fun LabeledBlock(title: String, detail: String) {
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(text = title, style = FoundryTheme.typography.bodyStrong, color = FoundryTheme.colors.textPrimary)
        if (detail.isNotBlank()) {
            Text(text = detail, style = FoundryTheme.typography.metaMono, color = FoundryTheme.colors.textDim)
        }
    }
}

@Composable
private fun LinkRow(label: String, url: String, onOpenUrl: (String) -> Unit) {
    Text(
        text = label,
        style = FoundryTheme.typography.labelMono,
        color = FoundryTheme.colors.accent,
        modifier = Modifier
            .clickable { onOpenUrl(url) }
            .semantics { contentDescription = label }
    )
}

@Composable
private fun LabeledMarkdown(label: String, body: String) {
    if (body.isBlank()) return
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(
            text = label.uppercase(),
            style = FoundryTheme.typography.eyebrowMono,
            color = FoundryTheme.colors.textFaint
        )
        MarkdownText(text = body)
    }
}

@Composable
private fun Disclosure(label: String, body: String) {
    if (body.isBlank()) return
    var open by rememberSaveable(label, body) { mutableStateOf(false) }
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(
            text = if (open) "Hide $label" else "Show $label",
            style = FoundryTheme.typography.labelMono,
            color = FoundryTheme.colors.textDim,
            modifier = Modifier
                .clickable { open = !open }
                .semantics { contentDescription = label }
        )
        if (open) {
            Text(
                text = body,
                style = FoundryTheme.typography.transcriptMono,
                color = FoundryTheme.colors.textPrimary
            )
        }
    }
}

@Composable
private fun JsonDisclosure(value: JsonObject) {
    Disclosure("JSON", value.prettyJson())
}

private fun artifactTitle(artifact: JsonObject): String {
    val kind = artifact.stringOr("kind")
    return when (kind) {
        "pipeline_design" -> artifact.objOrNull("pipeline")?.stringOr("name").orEmpty()
            .ifBlank { artifact.objOrNull("pipeline")?.stringOr("id").orEmpty() }
        "agent_design" -> artifact.objOrNull("agent")?.stringOr("name").orEmpty()
        "envelope_design" -> artifact.objOrNull("envelope")?.stringOr("name").orEmpty()
        "checklist" -> artifact.objOrNull("checklist")?.stringOr("title").orEmpty()
        "run_summary" -> artifact.stringOr("pipelineName").ifBlank { artifact.stringOr("runId") }
        "entity_comparison" -> artifact.stringOr("name")
        "change_receipt" -> artifact.objOrNull("receipt")?.stringOr("title").orEmpty()
            .ifBlank { artifact.objOrNull("receipt")?.stringOr("target").orEmpty() }
        "project_card" -> artifact.objOrNull("project")?.stringOr("name").orEmpty()
            .ifBlank { artifact.objOrNull("project")?.stringOr("path").orEmpty() }
        "pr_card" -> {
            val pr = artifact.objOrNull("pr")
            listOfNotNull(pr?.intOrNull("number")?.let { "#$it" }, pr?.stringOrNull("title")).joinToString(" ")
        }
        "settings_diff" -> artifact.objOrNull("diff")?.stringOr("title").orEmpty().ifBlank { "Settings changes" }
        "diagnostics" -> artifact.objOrNull("diagnostics")?.stringOr("title").orEmpty().ifBlank { "Diagnostics" }
        "data_table" -> artifact.objOrNull("table")?.stringOr("title").orEmpty()
        "evidence_disclosure" -> artifact.objOrNull("evidence")?.stringOr("title").orEmpty()
        "engineer_checkpoint" -> artifact.objOrNull("checkpoint")?.stringOr("title").orEmpty()
        "readiness_journey" -> artifact.objOrNull("journey")?.stringOr("projectName").orEmpty()
            .ifBlank { "Agent readiness" }
        "provider_status" -> artifact.objOrNull("status")?.stringOr("title").orEmpty()
            .ifBlank { "Providers and Companion" }
        "action_receipt" -> artifact.objOrNull("receipt")?.stringOr("title").orEmpty()
        else -> artifact.stringOrNull("title") ?: artifact.stringOrNull("name").orEmpty()
    }
}

private fun stringify(value: JsonElement?): String = when (value) {
    null -> "—"
    is JsonPrimitive -> value.contentOrNull ?: value.toString()
    else -> value.toString()
}
