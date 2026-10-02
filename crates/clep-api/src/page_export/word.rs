//! Markdown-to-Word rendering. All asset access belongs to the snapshot's loader.

use std::{collections::HashMap, io::Cursor, iter::Peekable};

use docx_rs::*;
use pulldown_cmark::{Alignment, Event, LinkType, Options, Parser, Tag, TagEnd};

use super::{comments_only, raster_png, safe_external_url, skip_until_end};

const TEXT_WIDTH: usize = 9360; // Letter, with one-inch side margins (twips).
const ACCENT: &str = "264F96";

pub(super) fn render(
    title: &str,
    markdown: &str,
    load_image: impl FnMut(&str) -> Result<Vec<u8>, String>,
) -> Result<Vec<u8>, String> {
    // Wiki parsing is enabled only at this presentation boundary: destinations are
    // never exported. Code spans/blocks remain literal parser events.
    let options = clep_vault::markdown::markdown_options() | Options::ENABLE_WIKILINKS;
    let mut definitions = HashMap::new();
    let mut source = Parser::new_ext(markdown, options);
    while let Some(event) = source.next() {
        if let Event::Start(Tag::FootnoteDefinition(name)) = event {
            let mut body = Vec::new();
            for event in source.by_ref() {
                if event == Event::End(TagEnd::FootnoteDefinition) {
                    break;
                }
                body.push(event);
            }
            definitions.insert(name.to_string(), body);
        }
    }
    let mut renderer = Renderer {
        load_image,
        definitions,
        footnotes: HashMap::new(),
        abstract_numberings: Vec::new(),
        numberings: Vec::new(),
        in_footnote: false,
    };
    let blocks = renderer.blocks(
        &mut Parser::new_ext(markdown, options).peekable(),
        None,
        Context::default(),
    )?;
    let mut doc = styled_document().add_paragraph(
        Paragraph::new()
            .style("Title")
            .keep_next(true)
            .add_run(Run::new().add_text(title)),
    );
    let has_numbering = !renderer.numberings.is_empty();
    for numbering in renderer.abstract_numberings {
        doc = doc.add_abstract_numbering(numbering);
    }
    for numbering in renderer.numberings {
        doc = doc.add_numbering(numbering);
    }
    doc.document.has_numbering = has_numbering;
    doc.document_rels.has_numberings = has_numbering;
    doc.document.children.extend(blocks);
    let mut output = Cursor::new(Vec::new());
    let mut package = doc.build();
    if !renderer.footnotes.is_empty() {
        package.footnotes = complete_footnotes(&package.footnotes)?;
    }
    package
        .pack(&mut output)
        .map_err(|error| format!("Could not assemble Word document: {error}"))?;
    Ok(output.into_inner())
}

fn footnote_reference_style() -> Style {
    let mut style =
        Style::new("FootnoteReference", StyleType::Character).name("Footnote Reference");
    style.run_property = style.run_property.vert_align(VertAlignType::SuperScript);
    style
}

/// docx-rs emits repeated footnote definitions and omits the number marker
/// from their bodies. Repair just that part using XML events before packing.
fn complete_footnotes(xml: &[u8]) -> Result<Vec<u8>, String> {
    use quick_xml::events::Event as XmlEvent;
    let mut reader = quick_xml::Reader::from_reader(xml);
    let mut writer = quick_xml::Writer::new(Vec::with_capacity(xml.len()));
    let mut seen = std::collections::HashSet::new();
    let mut skipped_depth = 0;
    let mut needs_marker = false;
    loop {
        let event = reader.read_event().map_err(|error| error.to_string())?;
        if matches!(event, XmlEvent::Eof) {
            break;
        }
        if skipped_depth != 0 {
            match event {
                XmlEvent::Start(_) => skipped_depth += 1,
                XmlEvent::End(_) => skipped_depth -= 1,
                _ => {}
            }
            continue;
        }
        if let XmlEvent::Start(element) = &event
            && element.name().as_ref() == b"w:footnote"
        {
            let id = element
                .try_get_attribute("w:id")
                .map_err(|error| error.to_string())?
                .ok_or("Generated footnote is missing its ID")?
                .unescape_value()
                .map_err(|error| error.to_string())?
                .into_owned();
            if !seen.insert(id) {
                skipped_depth = 1;
                continue;
            }
            needs_marker = true;
        }
        let insert_marker = needs_marker
            && matches!(&event,
            XmlEvent::End(element) if element.name().as_ref() == b"w:pPr");
        writer
            .write_event(event)
            .map_err(|error| error.to_string())?;
        if insert_marker {
            writer.get_mut().extend_from_slice(
                br#"<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteRef/></w:r><w:r><w:t xml:space="preserve"> </w:t></w:r>"#,
            );
            needs_marker = false;
        }
    }
    Ok(writer.into_inner())
}

fn fonts(name: &str) -> RunFonts {
    RunFonts::new().ascii(name).hi_ansi(name).cs(name)
}

fn styled_document() -> Docx {
    let body_spacing = LineSpacing::new().line(276).after(140);
    let mut doc = Docx::new()
        .page_size(12240, 15840)
        .page_margin(PageMargin {
            top: 1080,
            bottom: 1080,
            left: 1440,
            right: 1440,
            header: 540,
            footer: 540,
            gutter: 0,
        })
        .default_fonts(fonts("Calibri"))
        .default_size(22)
        .default_line_spacing(body_spacing.clone())
        .add_style(
            Style::new("BodyText", StyleType::Paragraph)
                .name("Body Text")
                .based_on("Normal")
                .fonts(fonts("Calibri"))
                .size(22)
                .color("252B34")
                .line_spacing(body_spacing),
        )
        .add_style(
            Style::new("Title", StyleType::Paragraph)
                .name("Title")
                .based_on("BodyText")
                .next("BodyText")
                .size(52)
                .color(ACCENT)
                .line_spacing(LineSpacing::new().after(300)),
        )
        .add_style(
            Style::new("Quote", StyleType::Paragraph)
                .name("Quote")
                .based_on("BodyText")
                .italic()
                .color("576170"),
        )
        .add_style(
            Style::new("Callout", StyleType::Paragraph)
                .name("Callout")
                .based_on("BodyText")
                .color("34445D"),
        )
        .add_style(
            Style::new("CodeBlock", StyleType::Paragraph)
                .name("Code Block")
                .based_on("BodyText")
                .fonts(fonts("Courier New"))
                .size(19)
                .line_spacing(LineSpacing::new().line(240).before(100).after(180)),
        )
        .add_style(
            Style::new("Code", StyleType::Character)
                .name("Code")
                .fonts(fonts("Courier New"))
                .size(19),
        )
        .add_style(
            Style::new("Hyperlink", StyleType::Character)
                .name("Hyperlink")
                .color(ACCENT)
                .underline("single"),
        )
        .add_style(
            Style::new("FootnoteText", StyleType::Paragraph)
                .name("Footnote Text")
                .based_on("BodyText")
                .size(18),
        )
        .add_style(footnote_reference_style())
        .footer(
            Footer::new().add_paragraph(
                Paragraph::new()
                    .align(AlignmentType::Center)
                    .size(18)
                    .color("667080")
                    .add_page_num(PageNum::new()),
            ),
        );
    for (level, size) in [36, 30, 26, 24, 22, 22].into_iter().enumerate() {
        let mut style = Style::new(format!("Heading{}", level + 1), StyleType::Paragraph)
            .name(format!("Heading {}", level + 1))
            .based_on("BodyText")
            .next("BodyText")
            .size(size)
            .bold()
            .color(ACCENT)
            .outline_lvl(level)
            .line_spacing(LineSpacing::new().before(260).after(120));
        style.paragraph_property = style.paragraph_property.keep_next(true);
        doc = doc.add_style(style);
    }
    doc
}

#[derive(Clone, Copy, Default)]
struct Context {
    list_depth: usize,
    quote_depth: usize,
    callout: bool,
    cell_width: Option<usize>,
}

impl Context {
    fn indent(self) -> i32 {
        (self.list_depth * 480 + self.quote_depth * 360) as i32
    }

    fn paragraph(self) -> Paragraph {
        let mut p = Paragraph::new().style("BodyText").widow_control(true);
        if self.indent() != 0 {
            p = p.indent(Some(self.indent()), None, None, None);
        }
        if self.quote_depth != 0 {
            p = p.style(if self.callout { "Callout" } else { "Quote" });
            p.property.borders = Some(
                ParagraphBorders::with_empty().set(
                    ParagraphBorder::new(ParagraphBorderPosition::Left)
                        .color(if self.callout { ACCENT } else { "BCC4CF" })
                        .size(18)
                        .space(10),
                ),
            );
        }
        p
    }

    fn image_width(self) -> usize {
        self.cell_width
            .unwrap_or(TEXT_WIDTH)
            .saturating_sub(self.indent() as usize + 240)
            .max(240)
    }
}

#[derive(Clone, Copy, Default)]
struct InlineStyle {
    bold: bool,
    italic: bool,
    strike: bool,
}

impl InlineStyle {
    fn run(self) -> Run {
        let mut run = Run::new();
        if self.bold {
            run = run.bold();
        }
        if self.italic {
            run = run.italic();
        }
        if self.strike {
            run = run.strike();
        }
        run
    }
}

struct Renderer<'a, F> {
    load_image: F,
    definitions: HashMap<String, Vec<Event<'a>>>,
    footnotes: HashMap<String, Footnote>,
    abstract_numberings: Vec<AbstractNumbering>,
    numberings: Vec<Numbering>,
    in_footnote: bool,
}

impl<'a, F: FnMut(&str) -> Result<Vec<u8>, String>> Renderer<'a, F> {
    fn blocks<I: Iterator<Item = Event<'a>>>(
        &mut self,
        events: &mut Peekable<I>,
        end: Option<TagEnd>,
        context: Context,
    ) -> Result<Vec<DocumentChild>, String> {
        let mut blocks = Vec::new();
        while let Some(event) = events.peek() {
            if matches!(event, Event::End(tag) if Some(*tag) == end) {
                events.next();
                break;
            }
            match event {
                Event::Start(Tag::Paragraph | Tag::Heading { .. } | Tag::DefinitionListTitle) => {
                    let Some(Event::Start(tag)) = events.next() else {
                        unreachable!()
                    };
                    let mut p = context.paragraph();
                    if let Tag::Heading { level, .. } = &tag {
                        p = p
                            .style(&format!("Heading{}", *level as usize))
                            .keep_next(true);
                    }
                    let style = InlineStyle {
                        bold: matches!(tag, Tag::DefinitionListTitle),
                        ..InlineStyle::default()
                    };
                    self.inlines(events, Some(tag.to_end()), &mut p, style, context)?;
                    blocks.push(DocumentChild::Paragraph(Box::new(p)));
                }
                Event::Start(Tag::CodeBlock(_)) => {
                    events.next();
                    let mut p = context.paragraph().style("CodeBlock");
                    for event in events.by_ref() {
                        match event {
                            Event::End(TagEnd::CodeBlock) => break,
                            Event::Text(text) => {
                                p = p.add_run(
                                    literal_run(&text).shading(Shading::new().fill("F0F2F5")),
                                );
                            }
                            _ => return Err("Unsupported content inside a code block".into()),
                        }
                    }
                    blocks.push(DocumentChild::Paragraph(Box::new(p)));
                }
                Event::Start(Tag::List(_)) => {
                    let Some(Event::Start(Tag::List(start))) = events.next() else {
                        unreachable!()
                    };
                    blocks.extend(self.list(events, start, context)?);
                }
                Event::Start(Tag::BlockQuote(_)) => {
                    let Some(Event::Start(Tag::BlockQuote(kind))) = events.next() else {
                        unreachable!()
                    };
                    let quoted = Context {
                        quote_depth: context.quote_depth + 1,
                        callout: kind.is_some(),
                        ..context
                    };
                    if let Some(kind) = kind {
                        blocks.push(DocumentChild::Paragraph(Box::new(
                            quoted.paragraph().keep_next(true).add_run(
                                Run::new()
                                    .add_text(format!("{kind:?}"))
                                    .bold()
                                    .color(ACCENT),
                            ),
                        )));
                    }
                    blocks.extend(self.blocks(events, Some(TagEnd::BlockQuote(kind)), quoted)?);
                }
                Event::Start(Tag::Table(_)) => {
                    let Some(Event::Start(Tag::Table(alignments))) = events.next() else {
                        unreachable!()
                    };
                    blocks.push(DocumentChild::Table(Box::new(self.table(
                        events,
                        &alignments,
                        context,
                    )?)));
                }
                Event::Start(Tag::FootnoteDefinition(_) | Tag::MetadataBlock(_)) => {
                    skip_element(events);
                }
                Event::Start(Tag::DefinitionList | Tag::DefinitionListDefinition) => {
                    let Some(Event::Start(tag)) = events.next() else {
                        unreachable!()
                    };
                    let nested = Context {
                        quote_depth: context.quote_depth
                            + usize::from(matches!(tag, Tag::DefinitionListDefinition)),
                        ..context
                    };
                    blocks.extend(self.blocks(events, Some(tag.to_end()), nested)?);
                }
                Event::Start(Tag::HtmlBlock) => {
                    events.next();
                    let mut html = String::new();
                    for event in events.by_ref() {
                        match event {
                            Event::End(TagEnd::HtmlBlock) => break,
                            Event::Html(text) => html.push_str(&text),
                            _ => return Err("Unsupported HTML block in Word export".into()),
                        }
                    }
                    if !comments_only(&html) {
                        return Err("Word export does not support raw HTML blocks".into());
                    }
                }
                Event::Rule => {
                    events.next();
                    let mut p = context.paragraph();
                    p.property.borders = Some(
                        ParagraphBorders::with_empty().set(
                            ParagraphBorder::new(ParagraphBorderPosition::Bottom)
                                .color("BCC4CF")
                                .size(6),
                        ),
                    );
                    blocks.push(DocumentChild::Paragraph(Box::new(p)));
                }
                Event::End(_) => return Err("Unexpected Markdown block boundary".into()),
                _ => {
                    // Tight list items do not contain Paragraph start/end events.
                    let mut p = context.paragraph();
                    self.inlines(events, None, &mut p, InlineStyle::default(), context)?;
                    blocks.push(DocumentChild::Paragraph(Box::new(p)));
                }
            }
        }
        Ok(blocks)
    }

    fn list<I: Iterator<Item = Event<'a>>>(
        &mut self,
        events: &mut Peekable<I>,
        start: Option<u64>,
        context: Context,
    ) -> Result<Vec<DocumentChild>, String> {
        if context.list_depth >= 9 {
            return Err("Word supports at most nine nested list levels".into());
        }
        let first = usize::try_from(start.unwrap_or(1))
            .ok()
            .filter(|n| *n <= i32::MAX as usize)
            .ok_or("List start is outside Word's supported range")?;
        // docx-rs always writes its built-in decimal numbering with ID 1.
        let id = self.numberings.len() + 2;
        let level = context.list_depth;
        let indent = context.indent() + 480;
        let abstract_numbering = AbstractNumbering::new(id).add_level(
            Level::new(
                level,
                Start::new(first),
                NumberFormat::new(if start.is_some() { "decimal" } else { "bullet" }),
                LevelText::new(if start.is_some() {
                    format!("%{}.", level + 1)
                } else {
                    "•".into()
                }),
                LevelJc::new("left"),
            )
            .indent(
                Some(indent),
                Some(SpecialIndentType::Hanging(240)),
                None,
                None,
            ),
        );
        self.abstract_numberings.push(abstract_numbering);
        self.numberings
            .push(Numbering::new(id, id).add_override(LevelOverride::new(level).start(first)));
        let mut blocks = Vec::new();
        while let Some(event) = events.next() {
            match event {
                Event::End(TagEnd::List(_)) => break,
                Event::Start(Tag::Item) => {
                    let mut item = self.blocks(
                        events,
                        Some(TagEnd::Item),
                        Context {
                            list_depth: level + 1,
                            ..context
                        },
                    )?;
                    // An item beginning with a nested list/table still needs its own marker.
                    if !matches!(item.first(), Some(DocumentChild::Paragraph(p)) if !p.has_numbering)
                    {
                        item.insert(0, DocumentChild::Paragraph(Box::new(context.paragraph())));
                    }
                    if let Some(DocumentChild::Paragraph(p)) = item.first_mut() {
                        **p = std::mem::take(p.as_mut())
                            .numbering(NumberingId::new(id), IndentLevel::new(level))
                            .indent(
                                Some(indent),
                                Some(SpecialIndentType::Hanging(240)),
                                None,
                                None,
                            );
                    }
                    blocks.extend(item);
                }
                _ => return Err("Unexpected content in a Markdown list".into()),
            }
        }
        Ok(blocks)
    }

    fn table<I: Iterator<Item = Event<'a>>>(
        &mut self,
        events: &mut Peekable<I>,
        alignments: &[Alignment],
        context: Context,
    ) -> Result<Table, String> {
        let width = TEXT_WIDTH
            .saturating_sub(context.indent() as usize)
            .max(480);
        let cell_width = width / alignments.len().max(1);
        let mut rows = Vec::new();
        while let Some(event) = events.next() {
            match event {
                Event::End(TagEnd::Table) => break,
                Event::Start(Tag::TableHead | Tag::TableRow) => {
                    let header = matches!(event, Event::Start(Tag::TableHead));
                    let mut cells = Vec::with_capacity(alignments.len());
                    while let Some(event) = events.next() {
                        match event {
                            Event::End(TagEnd::TableHead | TagEnd::TableRow) => break,
                            Event::Start(Tag::TableCell) => {
                                let mut p = Paragraph::new().style("BodyText");
                                p = match alignments.get(cells.len()) {
                                    Some(Alignment::Center) => p.align(AlignmentType::Center),
                                    Some(Alignment::Right) => p.align(AlignmentType::Right),
                                    _ => p,
                                };
                                self.inlines(
                                    events,
                                    Some(TagEnd::TableCell),
                                    &mut p,
                                    InlineStyle {
                                        bold: header,
                                        ..InlineStyle::default()
                                    },
                                    Context {
                                        cell_width: Some(cell_width),
                                        ..Context::default()
                                    },
                                )?;
                                let mut cell = TableCell::new()
                                    .width(cell_width, WidthType::Dxa)
                                    .add_paragraph(p);
                                if header {
                                    cell = cell.shading(Shading::new().fill("E8EEF7"));
                                }
                                cells.push(cell);
                            }
                            _ => return Err("Unexpected Markdown table content".into()),
                        }
                    }
                    rows.push(TableRow::new(cells).cant_split());
                }
                _ => return Err("Unexpected Markdown table row".into()),
            }
        }
        Ok(Table::new(rows)
            .width(width, WidthType::Dxa)
            .set_grid(vec![cell_width; alignments.len()])
            .indent(context.indent()))
    }

    fn inlines<I: Iterator<Item = Event<'a>>>(
        &mut self,
        events: &mut Peekable<I>,
        end: Option<TagEnd>,
        paragraph: &mut Paragraph,
        style: InlineStyle,
        context: Context,
    ) -> Result<(), String> {
        while let Some(event) = events.peek() {
            if matches!(event, Event::End(tag) if Some(*tag) == end) {
                events.next();
                break;
            }
            if end.is_none() && is_block_boundary(event) {
                break;
            }
            let Some(event) = events.next() else { break };
            match event {
                Event::Text(text) => push_run(paragraph, style.run().add_text(text.as_ref())),
                Event::Code(text) => push_run(
                    paragraph,
                    style
                        .run()
                        .add_text(text.as_ref())
                        .style("Code")
                        .shading(Shading::new().fill("F0F2F5")),
                ),
                Event::SoftBreak => push_run(paragraph, style.run().add_text(" ")),
                Event::HardBreak => {
                    push_run(paragraph, style.run().add_break(BreakType::TextWrapping))
                }
                Event::TaskListMarker(checked) => push_run(
                    paragraph,
                    style.run().add_text(if checked { "☑ " } else { "☐ " }),
                ),
                Event::Start(Tag::Emphasis | Tag::Strong | Tag::Strikethrough) => {
                    let Event::Start(tag) = event else {
                        unreachable!()
                    };
                    let nested = InlineStyle {
                        bold: style.bold || matches!(tag, Tag::Strong),
                        italic: style.italic || matches!(tag, Tag::Emphasis),
                        strike: style.strike || matches!(tag, Tag::Strikethrough),
                    };
                    self.inlines(events, Some(tag.to_end()), paragraph, nested, context)?;
                }
                Event::Start(Tag::Link {
                    link_type,
                    dest_url,
                    ..
                }) => {
                    let mut label = Paragraph::new();
                    self.inlines(events, Some(TagEnd::Link), &mut label, style, context)?;
                    if matches!(link_type, LinkType::WikiLink { has_pothole: false }) {
                        // An unaliased wiki path has no separate label. Export only its leaf.
                        let leaf = dest_url.rsplit('/').next().unwrap_or(&dest_url);
                        let leaf = leaf.strip_suffix(".md").unwrap_or(leaf);
                        push_run(paragraph, style.run().add_text(leaf));
                    } else if !matches!(link_type, LinkType::WikiLink { .. })
                        && safe_external_url(&dest_url)
                    {
                        if self.in_footnote {
                            // Fields need no relationships part (docx-rs cannot emit
                            // a footnotes.xml.rels part). Serialize the instruction
                            // directly: its HYPERLINK enum writer is unimplemented.
                            let target = dest_url.replace('"', "%22").replace('\\', "%5C");
                            push_run(
                                paragraph,
                                Run::new()
                                    .add_field_char(FieldCharType::Begin, false)
                                    .add_instr_text(InstrText::Unsupported(format!(
                                        " HYPERLINK \"{target}\" "
                                    )))
                                    .add_field_char(FieldCharType::Separate, false),
                            );
                            paragraph.children.extend(label.children);
                            push_run(
                                paragraph,
                                Run::new().add_field_char(FieldCharType::End, false),
                            );
                            continue;
                        }
                        let mut link = Hyperlink::new(dest_url.as_ref(), HyperlinkType::External);
                        for child in label.children {
                            if let ParagraphChild::Run(run) = child {
                                link = link.add_run((*run).style("Hyperlink"));
                            } else {
                                return Err(
                                    "Nested hyperlinks are not supported in Word export".into()
                                );
                            }
                        }
                        paragraph.children.push(ParagraphChild::Hyperlink(link));
                    } else {
                        paragraph.children.extend(label.children);
                    }
                }
                Event::Start(Tag::Image { dest_url, .. }) => {
                    if self.in_footnote {
                        return Err("Images in footnotes are not supported in Word export".into());
                    }
                    // The source has already been validated/resolved by the snapshot.
                    skip_until_end(events, TagEnd::Image);
                    let data = (self.load_image)(&dest_url)?;
                    let pic = image_picture(data, context.image_width())?;
                    push_run(paragraph, style.run().add_image(pic));
                }
                Event::FootnoteReference(name) => {
                    if self.in_footnote {
                        return Err(
                            "Nested footnote references are not supported in Word export".into(),
                        );
                    }
                    if !self.footnotes.contains_key(name.as_ref()) {
                        let body = self
                            .definitions
                            .remove(name.as_ref())
                            .ok_or_else(|| format!("Footnote '{name}' has no definition"))?;
                        self.in_footnote = true;
                        let blocks = self.blocks(
                            &mut body.into_iter().peekable(),
                            None,
                            Context::default(),
                        )?;
                        self.in_footnote = false;
                        let mut footnote = Footnote::new();
                        for block in blocks {
                            match block {
                                DocumentChild::Paragraph(p) => {
                                    footnote.content.push((*p).style("FootnoteText"))
                                }
                                DocumentChild::Table(_) => {
                                    return Err(
                                        "Tables in footnotes are not supported in Word export"
                                            .into(),
                                    );
                                }
                                _ => return Err("Unsupported document content in footnotes".into()),
                            }
                        }
                        self.footnotes.insert(name.to_string(), footnote);
                    }
                    push_run(
                        paragraph,
                        style
                            .run()
                            .add_footnote_reference(self.footnotes[name.as_ref()].clone()),
                    );
                }
                Event::Html(html) | Event::InlineHtml(html) => {
                    if matches!(html.trim(), "<br>" | "<br/>" | "<br />") {
                        push_run(paragraph, style.run().add_break(BreakType::TextWrapping));
                    } else if !comments_only(&html) {
                        return Err("Word export does not support raw HTML".into());
                    }
                }
                Event::InlineMath(_) | Event::DisplayMath(_) => {
                    return Err("Word export does not yet support mathematical notation".into());
                }
                _ => return Err("Unsupported Markdown inline content in Word export".into()),
            }
        }
        Ok(())
    }
}

fn push_run(paragraph: &mut Paragraph, run: Run) {
    paragraph.children.push(ParagraphChild::Run(Box::new(run)));
}

fn is_block_boundary(event: &Event<'_>) -> bool {
    matches!(
        event,
        Event::End(_)
            | Event::Rule
            | Event::Start(
                Tag::Paragraph
                    | Tag::Heading { .. }
                    | Tag::BlockQuote(_)
                    | Tag::CodeBlock(_)
                    | Tag::List(_)
                    | Tag::Item
                    | Tag::Table(_)
                    | Tag::FootnoteDefinition(_)
                    | Tag::DefinitionList
                    | Tag::DefinitionListTitle
                    | Tag::DefinitionListDefinition
                    | Tag::HtmlBlock
                    | Tag::MetadataBlock(_)
            )
    )
}

fn skip_element<'a>(events: &mut impl Iterator<Item = Event<'a>>) {
    if let Some(Event::Start(tag)) = events.next() {
        skip_until_end(events, tag.to_end());
    }
}

fn literal_run(text: &str) -> Run {
    let mut run = Run::new();
    for (line_index, line) in text.split('\n').enumerate() {
        if line_index != 0 {
            run = run.add_break(BreakType::TextWrapping);
        }
        for (part_index, part) in line.split('\t').enumerate() {
            if part_index != 0 {
                run = run.add_tab();
            }
            run = run.add_text(part);
        }
    }
    run
}

fn image_picture(bytes: Vec<u8>, width_twips: usize) -> Result<Pic, String> {
    // Pic::new panics on decoding errors; the shared decoder fails cleanly instead.
    let (png, width, height) = raster_png(bytes)?;
    let max_width = width_twips as f64 * 635.0;
    let max_height = 7.5 * 914400.0;
    let scale = (max_width / (width as f64 * 9525.0))
        .min(max_height / (height as f64 * 9525.0))
        .min(1.0);
    let display_width = (width as f64 * 9525.0 * scale).round().max(1.0) as u32;
    let display_height = (height as f64 * 9525.0 * scale).round().max(1.0) as u32;
    Ok(Pic::new_with_dimensions(png, width, height).size(display_width, display_height))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    fn archive(markdown: &str) -> zip::ZipArchive<Cursor<Vec<u8>>> {
        zip::ZipArchive::new(Cursor::new(
            render("A saved title", markdown, |_| {
                Err("No image expected".into())
            })
            .unwrap(),
        ))
        .unwrap()
    }

    fn member(archive: &mut zip::ZipArchive<Cursor<Vec<u8>>>, name: &str) -> String {
        let mut text = String::new();
        archive
            .by_name(name)
            .unwrap()
            .read_to_string(&mut text)
            .unwrap();
        text
    }

    fn elements(xml: &str, name: &[u8], attribute: &[u8]) -> Vec<String> {
        let mut reader = quick_xml::Reader::from_str(xml);
        let mut result = Vec::new();
        loop {
            match reader.read_event().unwrap() {
                quick_xml::events::Event::Start(element)
                | quick_xml::events::Event::Empty(element)
                    if element.name().as_ref() == name =>
                {
                    if let Some(value) = element.try_get_attribute(attribute).unwrap() {
                        result.push(value.unescape_value().unwrap().into_owned());
                    }
                }
                quick_xml::events::Event::Eof => break,
                _ => {}
            }
        }
        result
    }

    #[test]
    fn preserves_visible_content_without_private_targets_or_metadata() {
        let mut doc = archive(
            "---\nsecret: private-frontmatter\n---\n# Heading\n\n[[private/folder/secret.md|Public label]] and [safe](https://example.org/guide) and [local](clepsydra://private-target).\n\n`[[literal|code]]`\n\n```text\n[[literal-block|code]]\n\tsecond line\n```\n\n<!-- generated-private-marker -->\n\n**bold** *italic* ~~removed~~",
        );
        let xml = member(&mut doc, "word/document.xml");
        let rels = member(&mut doc, "word/_rels/document.xml.rels");
        for visible in [
            "A saved title",
            "Heading",
            "Public label",
            "safe",
            "local",
            "[[literal|code]]",
            "[[literal-block|code]]",
            "second line",
            "bold",
            "italic",
            "removed",
        ] {
            assert!(xml.contains(visible), "missing {visible}");
        }
        for hidden in [
            "private/folder",
            "secret.md",
            "private-target",
            "private-frontmatter",
            "generated-private-marker",
        ] {
            assert!(!xml.contains(hidden), "leaked {hidden}");
            assert!(!rels.contains(hidden), "leaked relationship {hidden}");
        }
        assert!(
            elements(&rels, b"Relationship", b"Target")
                .contains(&"https://example.org/guide".into())
        );
        let styles = member(&mut doc, "word/styles.xml");
        assert!(elements(&styles, b"w:outlineLvl", b"w:val").contains(&"0".into()));
        assert!(elements(&xml, b"w:pStyle", b"w:val").contains(&"Heading1".into()));
    }

    #[test]
    fn keeps_nested_lists_and_independent_ordered_restarts() {
        let mut doc = archive(
            "3. Third\n   - Nested bullet\n\n     7. Nested seventh\n   - Second bullet\n4. Fourth\n\nA break.\n\n9. Ninth\n10. Tenth\n\n- [ ] Open task\n- [x] Done task",
        );
        let xml = member(&mut doc, "word/document.xml");
        let numbering = member(&mut doc, "word/numbering.xml");
        for (element, attribute) in [
            (b"w:num".as_slice(), b"w:numId".as_slice()),
            (b"w:abstractNum".as_slice(), b"w:abstractNumId".as_slice()),
        ] {
            let ids = elements(&numbering, element, attribute);
            assert_eq!(
                ids.len(),
                ids.iter().collect::<std::collections::HashSet<_>>().len(),
                "numbering definitions must have unique IDs"
            );
        }
        let ids = elements(&xml, b"w:numId", b"w:val");
        assert_eq!(ids[0], ids[4], "outer sequence must resume after nesting");
        assert_eq!(ids[1], ids[3], "nested bullet sequence must resume");
        assert_ne!(ids[0], ids[5], "separate ordered lists must restart");
        assert_eq!(
            elements(&xml, b"w:ilvl", b"w:val")[..5],
            ["0", "1", "2", "1", "0"]
        );
        let starts = elements(&numbering, b"w:startOverride", b"w:val");
        for start in ["3", "7", "9"] {
            assert!(starts.iter().any(|value| value == start));
        }
        assert!(xml.contains("☐ ") && xml.contains("☑ "));
    }

    #[test]
    fn embeds_images_and_preserves_table_and_footnote_content() {
        let mut png = Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(1200, 600)
            .write_to(&mut png, image::ImageFormat::Png)
            .unwrap();
        let bytes = render("Illustrated", "| Name | Meaning |\n| --- | --- |\n| **Alpha** | First |\n\n![Chart](attachments/chart.png)\n\nA claim[^source].\n\n[^source]: Supporting *evidence*.\n", |path| {
            assert_eq!(path, "attachments/chart.png");
            Ok(png.get_ref().clone())
        }).unwrap();
        let mut doc = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
        let xml = member(&mut doc, "word/document.xml");
        assert!(xml.contains("Alpha") && xml.contains("First"));
        let cx: u32 = elements(&xml, b"wp:extent", b"cx")[0].parse().unwrap();
        let cy: u32 = elements(&xml, b"wp:extent", b"cy")[0].parse().unwrap();
        assert_eq!(cx, cy * 2);
        assert!(cx <= TEXT_WIDTH as u32 * 635);
        let notes = member(&mut doc, "word/footnotes.xml");
        assert!(notes.contains("Supporting ") && notes.contains("evidence"));
    }

    #[test]
    fn repeated_footnotes_share_a_number_and_keep_clickable_sources() {
        let mut doc = archive(
            "First[^evidence] and second[^evidence].\n\n[^evidence]: See [the source](https://example.org/evidence).\n",
        );
        let body = member(&mut doc, "word/document.xml");
        let notes = member(&mut doc, "word/footnotes.xml");
        let references = elements(&body, b"w:footnoteReference", b"w:id");
        assert_eq!(references.len(), 2);
        assert_eq!(references[0], references[1]);
        assert_eq!(
            elements(&notes, b"w:footnote", b"w:id"),
            vec![references[0].clone()]
        );
        assert!(
            notes.contains("<w:footnoteRef"),
            "footnote body needs its visible number"
        );
        assert!(notes.contains("HYPERLINK") && notes.contains("https://example.org/evidence"));
        assert!(notes.contains("the source"));
    }

    #[test]
    fn rejects_missing_corrupt_and_unsupported_images_without_panicking() {
        assert!(
            render("Title", "![missing](missing.png)", |_| Err(
                "Missing attachment".into()
            ))
            .unwrap_err()
            .contains("Missing attachment")
        );
        for bytes in [
            b"not an image".as_slice(),
            b"\x89PNG\r\n\x1a\n".as_slice(),
            b"<svg></svg>".as_slice(),
        ] {
            assert!(render("Title", "![bad](bad.png)", |_| Ok(bytes.to_vec())).is_err());
        }
    }
}
