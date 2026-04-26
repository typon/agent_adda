use uuid::Uuid;

pub const DEFAULT_MEMORY_CLAUSE: &str = "The wiki is the company's shared memory. Before starting work, search and read the relevant wiki pages. While working, link to wiki pages when they explain a decision. After completing work, update the wiki with durable facts, decisions, architecture changes, runbooks, and open questions. If no durable knowledge changed, explicitly say so in your run summary.";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WikiLinkTarget {
    pub slug: String,
    pub link_text: String,
}

pub fn slugify(input: &str) -> String {
    let slug = input
        .trim()
        .to_lowercase()
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
        .collect::<String>()
        .split('-')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("-");

    if slug.is_empty() {
        format!("page-{}", Uuid::new_v4())
    } else {
        slug
    }
}

pub fn wiki_slug(input: &str) -> Option<String> {
    if input.chars().any(|ch| ch.is_ascii_alphanumeric()) {
        Some(slugify(input))
    } else {
        None
    }
}

pub fn extract_wiki_link_targets(markdown: &str) -> Vec<WikiLinkTarget> {
    let mut links = Vec::new();
    let mut rest = markdown;
    while let Some(start) = rest.find("[[") {
        let after_start = &rest[start + 2..];
        let Some(end) = after_start.find("]]") else {
            break;
        };
        let link = after_start[..end].trim();
        if !link.is_empty() {
            let (target, label) = match link.split_once('|') {
                Some((target, label)) => {
                    let target = target.trim();
                    let label = label.trim();
                    let label = if label.is_empty() { target } else { label };
                    (target, label)
                }
                None => (link, link),
            };

            if let Some(slug) = wiki_slug(target) {
                links.push(WikiLinkTarget {
                    slug,
                    link_text: label.to_string(),
                });
            }
        }
        rest = &after_start[end + 2..];
    }
    links.sort_by(|left, right| {
        left.slug
            .cmp(&right.slug)
            .then(left.link_text.cmp(&right.link_text))
    });
    links.dedup();
    links
}

#[cfg(test)]
mod tests {
    use super::{WikiLinkTarget, extract_wiki_link_targets, slugify, wiki_slug};

    #[test]
    fn creates_slugs() {
        assert_eq!(slugify("Frontend Design System"), "frontend-design-system");
    }

    #[test]
    fn extracts_wiki_links() {
        assert_eq!(
            extract_wiki_link_targets("[[Mission]] and [[GitHub Workflow]]")
                .into_iter()
                .map(|link| link.slug)
                .collect::<Vec<_>>(),
            vec!["github-workflow", "mission"]
        );
    }

    #[test]
    fn extracts_wiki_link_targets_with_labels() {
        assert_eq!(
            extract_wiki_link_targets("[[Mission|mission brief]] and [[GitHub Workflow]]"),
            vec![
                WikiLinkTarget {
                    slug: "github-workflow".to_string(),
                    link_text: "GitHub Workflow".to_string(),
                },
                WikiLinkTarget {
                    slug: "mission".to_string(),
                    link_text: "mission brief".to_string(),
                },
            ]
        );
    }

    #[test]
    fn skips_wiki_links_without_stable_slugs() {
        assert_eq!(wiki_slug("!!!"), None);
        assert_eq!(
            extract_wiki_link_targets("[[!!!]] [[ ]] [[Valid Page]]")
                .into_iter()
                .map(|link| link.slug)
                .collect::<Vec<_>>(),
            vec!["valid-page"]
        );
    }
}
