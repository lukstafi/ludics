---
name: ludics-new-quote
description: Find a quote from Jean-Yves Girard that's not already in the project's quotes file. Use when the user runs `/ludics-new-quote` or asks to find new Girard quotes for the Ludics project.
---

# Find a New Girard Quote

This skill searches for quotable passages from Jean-Yves Girard's writings and cross-references them against the existing quotes file to find a fresh one.

## Procedure

1. **Locate the existing quotes file.** Look for a quotes file in the project — likely named `Girard_quotes.txt`. Search the project root and common locations. Read it to understand which quotes are already present. The format is: quote line followed by source line. 

2. **Search for Girard quotes.** Use web search to find quotable passages. Good sources and search strategies:
   - Search: `Girard "linear logic" quotes site:girard.perso.math.cnrs.fr`
   - Search: `Girard "Locus Solum" Ludics quotes remarks`
   - Search: `Girard "Blind Spot" lectures logic quotes`
   - Search: `Girard "meaning of logical rules" quotes`
   - Search: `Girard "geometry of interaction" quotes epigrams`
   - Search: `Girard "transcendental syntax" quotes`
   - Search: `Girard "From Foundations to Ludics" quotes`
   - Fetch full PDFs from `girard.perso.math.cnrs.fr` — his papers are freely available and full of gems
   - His writing style is uniquely colorful for a logician: look for his metaphors, sardonic asides, philosophical provocations, and sweeping declarations

3. **Cross-reference against existing quotes.** Compare candidate quotes against the quotes file. A quote is "new" if it doesn't appear in the file — check by substring matching on the distinctive phrase, not just exact match (the file might have slightly different punctuation or truncation).

4. **Select and verify one quote.** Pick the best candidate that is:
   - Actually by Girard (not a secondary source paraphrasing him)
   - Quotable: punchy, thought-provoking, or funny — not just a dry technical statement
   - From a specific, citable source (paper title + year)
   - Not already in the quotes file

5. **Present the quote.** Output:
   - The exact quote text
   - Source: paper/book title and year
   - A one-line note on context (what he's talking about) to help decide if it fits

6. **Optionally, suggest the formatted entry.** If you can determine the format from the quotes file, present the quote pre-formatted for copy-paste insertion.

## Girard's Key Works (chronological reference)

| Year | Title | Notes |
|------|-------|-------|
| 1987 | Linear Logic | The foundational paper — TCS vol. 50 |
| 1989 | Proofs and Types | Textbook with Taylor & Lafont |
| 1989 | Geometry of Interaction I | System F interpretation |
| 1993 | Linear Logic: A Survey | NATO ASI series |
| 1995 | Linear Logic: its syntax and semantics | In "Advances in Linear Logic" |
| 1998 | On the meaning of logical rules I | Syntax vs. semantics — very quotable |
| 2001 | Locus Solum | The ludics paper — 200+ pages, has illustrations of skunks |
| 2003 | From Foundations to Ludics | BSL survey |
| 2011 | The Blind Spot: Lectures on Logic | Book — chapter titles are great too |
| 2012 | Normativity in Logic | Geometry of Interaction in von Neumann algebras |
| 2012+ | Transcendental Syntax 1.0, 2.0 | Latest programme |
| 2016 | Le fantôme de la transparence | French — philosophical |

## Tips for Finding Good Quotes

Girard's most quotable passages tend to be:
- **Opening salvos**: The first paragraphs of his papers often contain provocative thesis statements
- **Footnotes**: He hides brilliant asides in footnotes (e.g., the Broccoli axiom jokes in "meaning of logical rules")
- **Glossary entries**: Locus Solum has a glossary/appendix with opinionated definitions (CATEGORY, SPIRITUALISM, LOCATIVE LOGIC, etc.)
- **Analogies to other fields**: He draws from physics, philosophy, literature, and politics
- **Attacks on the establishment**: His critiques of model theory, category theory, and "meta" reasoning are legendary
