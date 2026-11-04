//! A provider's models, merged from the layers of docs/kernel/model-catalog-design.md §4:
//! models.toml and built-in entries, the provider's list, the public catalog, the defaults.
//! Everything is read on first use and per provider, so a command that uses one model reads
//! one provider's files.

use parking_lot::Mutex;
use parking_lot::RwLock;
use serde::Deserialize;
use serde::Serialize;
use std::collections::BTreeSet;
use std::collections::HashMap;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;

use crate::catalog::ModelToml;
use crate::catalog::ProviderConfig;
use crate::catalog::merge_model;
use crate::discovery::ListSource;
use crate::discovery::ListedModel;
use crate::discovery::ModelList;
use crate::error::LlmError;
use crate::model::Modality;
use crate::model::Model;
use crate::model::ThinkingBudgets;
use crate::public_catalog::PublicModel;
use crate::public_catalog::PublicProvider;
use crate::public_catalog::ReasoningOption;
use crate::types::Currency;
use crate::types::ThinkingLevel;

/// How many models a provider shows by default (the newest).
pub const DEFAULT_SHOWN: usize = 12;

/// Where a provider's model ids came from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IdSource {
    /// The provider's list.
    Provider,
    /// No list: the public catalog's models.
    Catalog,
    /// Only the models written in models.toml or the built-in entries.
    Config,
}

/// What a picker needs to know about a model besides the model itself.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ModelMeta {
    /// Some layer above the defaults describes it.
    pub known: bool,
    pub deprecated: bool,
    /// `YYYY-MM-DD`
    pub released: Option<String>,
    /// Written in models.toml or the built-in entries.
    pub configured: bool,
    /// A chat model an agent can use.
    pub chat: bool,
}

#[derive(Clone, Debug)]
pub struct DirectoryModel {
    pub model: Arc<Model>,
    pub meta: ModelMeta,
}

/// One provider's merged models, in the order of their source.
#[derive(Clone, Debug)]
pub struct ProviderModels {
    pub source: IdSource,
    pub list: Option<ModelList>,
    pub models: Vec<DirectoryModel>,
}

impl ProviderModels {
    pub fn get(&self, id: &str) -> Option<&DirectoryModel> {
        self.models.iter().find(|m| m.model.id == id)
    }

    /// Ids shown by default (§6.2): known, not deprecated, the newest `DEFAULT_SHOWN`; configured
    /// models always. A provider that shares another's list shows only configured ones.
    pub fn default_shown(&self, shares_list: bool) -> BTreeSet<String> {
        let mut shown: BTreeSet<String> =
            self.models.iter().filter(|m| m.meta.configured).map(|m| m.model.id.clone()).collect();
        if shares_list {
            return shown;
        }
        let mut candidates: Vec<&DirectoryModel> = self
            .models
            .iter()
            .filter(|m| m.meta.chat && m.meta.known && !m.meta.deprecated && !m.meta.configured)
            .collect();
        candidates.sort_by(|a, b| {
            b.meta.released.is_some().cmp(&a.meta.released.is_some())
                .then_with(|| b.meta.released.cmp(&a.meta.released))
                .then_with(|| a.model.id.cmp(&b.model.id))
        });
        let room = DEFAULT_SHOWN.saturating_sub(shown.len());
        shown.extend(candidates.into_iter().take(room).map(|m| m.model.id.clone()));
        shown
    }
}

/// Models the user showed or hid by hand, by `provider/model-id` (§6.3), and the thinking level
/// last chosen on each model (§18).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Selection {
    #[serde(default)]
    pub version: u32,
    #[serde(default)]
    pub show: BTreeSet<String>,
    #[serde(default)]
    pub hide: BTreeSet<String>,
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub thinking: std::collections::BTreeMap<String, ThinkingLevel>,
}

impl Selection {
    pub fn is_shown(&self, reference: &str, by_default: bool) -> bool {
        !self.hide.contains(reference) && (by_default || self.show.contains(reference))
    }

    /// Records a choice; a choice equal to the default is forgotten.
    pub fn set(&mut self, reference: &str, shown: bool, by_default: bool) {
        self.show.remove(reference);
        self.hide.remove(reference);
        match (shown, by_default) {
            (true, false) => {
                self.show.insert(reference.to_string());
            }
            (false, true) => {
                self.hide.insert(reference.to_string());
            }
            _ => {}
        }
    }
}

/// The merged models of every provider, read lazily and dropped when something is refreshed.
#[derive(Default)]
pub struct ModelDirectory {
    dir: Option<PathBuf>,
    public: RwLock<HashMap<String, Option<Arc<PublicProvider>>>>,
    merged: RwLock<HashMap<String, Arc<ProviderModels>>>,
    selection: RwLock<Option<Arc<Selection>>>,
    /// Providers that said a model does not exist; their lists are refreshed.
    missing: Arc<Mutex<BTreeSet<String>>>,
}

impl ModelDirectory {
    /// `dir` is `~/.finx/models`; `None` keeps everything in memory (tests).
    pub fn new(dir: Option<PathBuf>) -> Self {
        Self { dir, ..Default::default() }
    }

    pub fn dir(&self) -> Option<&Path> {
        self.dir.as_deref()
    }

    pub fn catalog_dir(&self) -> Option<PathBuf> {
        self.dir.as_ref().map(|d| d.join("catalog"))
    }

    pub fn lists_dir(&self) -> Option<PathBuf> {
        self.dir.as_ref().map(|d| d.join("lists"))
    }

    /// Forget what was read, after a refresh or a key change.
    pub fn invalidate(&self) {
        self.public.write().clear();
        self.merged.write().clear();
        *self.selection.write() = None;
    }

    /// Where requests note providers whose model turned out not to exist.
    pub fn missing_handle(&self) -> Arc<Mutex<BTreeSet<String>>> {
        self.missing.clone()
    }

    /// Providers noted since the last call.
    pub fn take_missing(&self) -> BTreeSet<String> {
        std::mem::take(&mut *self.missing.lock())
    }

    pub fn list(&self, provider: &str) -> Option<ModelList> {
        crate::discovery::read_list(&self.lists_dir()?, provider)
    }

    pub fn public(&self, catalog_id: &str) -> Option<Arc<PublicProvider>> {
        if let Some(found) = self.public.read().get(catalog_id) {
            return found.clone();
        }
        let loaded = crate::public_catalog::load(self.catalog_dir().as_deref(), catalog_id).map(Arc::new);
        self.public.write().insert(catalog_id.to_string(), loaded.clone());
        loaded
    }

    /// A provider's merged models. Managed and plain providers are taken as they are.
    pub fn models(&self, provider: &ProviderConfig) -> Arc<ProviderModels> {
        if let Some(found) = self.merged.read().get(&provider.id) {
            return found.clone();
        }
        let merged = Arc::new(self.merge(provider));
        self.merged.write().insert(provider.id.clone(), merged.clone());
        merged
    }

    /// One model. Without the provider's merged models at hand, only what this model needs is
    /// read: its line of the public catalog and the provider's list. A model the catalog knows
    /// is found even when the list leaves it out.
    pub fn model(&self, provider: &ProviderConfig, id: &str) -> Option<Arc<Model>> {
        if provider.plan.is_some() {
            return self.models(provider).get(id).map(|m| m.model.clone());
        }
        if !provider.listing.is_dynamic() {
            return provider.model(id);
        }
        if let Some(found) = self.merged.read().get(&provider.id) {
            return found.get(id).map(|m| m.model.clone());
        }
        let listing = &provider.listing;
        let list = self.list(listing.from.as_deref().unwrap_or(&provider.id));
        let listed = list
            .as_ref()
            .filter(|l| l.source == ListSource::Provider)
            .and_then(|l| l.models.iter().find(|m| m.id == id));
        let public = listing.catalog_id.as_deref().and_then(|c| {
            match self.public.read().get(c) {
                Some(loaded) => loaded.as_ref().and_then(|p| p.model(id).cloned()),
                None => crate::public_catalog::load_one(self.catalog_dir().as_deref(), c, id),
            }
        });
        let entry = listing.entries.iter().find(|e| e.id == id);
        if listed.is_none() && public.is_none() && entry.is_none() {
            return None;
        }
        Some(build(provider, id, public.as_ref(), listed, entry).model)
    }

    fn merge(&self, provider: &ProviderConfig) -> ProviderModels {
        if !provider.listing.is_dynamic() {
            let models = provider
                .models
                .iter()
                .map(|model| DirectoryModel {
                    model: model.clone(),
                    meta: ModelMeta { known: true, configured: true, chat: true, ..Default::default() },
                })
                .collect();
            return ProviderModels { source: IdSource::Config, list: None, models };
        }
        let listing = &provider.listing;
        let list = self.list(listing.from.as_deref().unwrap_or(&provider.id));
        let public = listing.catalog_id.as_deref().and_then(|id| self.public(id));
        let listed: Option<&[ListedModel]> = list
            .as_ref()
            .filter(|l| l.source == ListSource::Provider && (provider.plan.is_some() || !l.models.is_empty()))
            .map(|l| l.models.as_slice());
        let (source, mut ids): (IdSource, Vec<String>) = match (listed, &public) {
            (Some(listed), _) => (IdSource::Provider, listed.iter().map(|m| m.id.clone()).collect()),
            (None, Some(public)) if provider.plan.is_none() => (IdSource::Catalog, public.models.iter().map(|m| m.id.clone()).collect()),
            (None, _) => (IdSource::Config, Vec::new()),
        };
        for entry in &listing.entries {
            // A plan list is authoritative; seeds only cover a missing list endpoint.
            if !(provider.plan.is_some() && listed.is_some()) && !ids.contains(&entry.id) {
                ids.push(entry.id.clone());
            }
        }
        let models = ids
            .into_iter()
            .map(|id| {
                let public = public.as_ref().and_then(|p| p.model(&id));
                let listed = listed.and_then(|l| l.iter().find(|m| m.id == id));
                let entry = listing.entries.iter().find(|e| e.id == id);
                build(provider, &id, public, listed, entry)
            })
            .collect();
        ProviderModels { source, list, models }
    }

    pub fn selection(&self) -> Arc<Selection> {
        if let Some(found) = self.selection.read().as_ref() {
            return found.clone();
        }
        let loaded: Selection = self
            .dir
            .as_ref()
            .and_then(|d| std::fs::read(d.join("selection.json")).ok())
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        let loaded = Arc::new(loaded);
        *self.selection.write() = Some(loaded.clone());
        loaded
    }

    pub fn set_shown(&self, reference: &str, shown: bool, by_default: bool) -> Result<(), LlmError> {
        self.change_selection(|selection| selection.set(reference, shown, by_default))
    }

    /// The thinking level last chosen on a model, if any.
    pub fn remembered_thinking(&self, reference: &str) -> Option<ThinkingLevel> {
        self.selection().thinking.get(reference).copied()
    }

    /// Remembers the level chosen on a model; `Default` forgets it. Unchanged levels write nothing.
    pub fn remember_thinking(&self, reference: &str, level: ThinkingLevel) -> Result<(), LlmError> {
        if self.remembered_thinking(reference).unwrap_or_default() == level {
            return Ok(());
        }
        self.change_selection(|selection| {
            if level == ThinkingLevel::Default {
                selection.thinking.remove(reference);
            } else {
                selection.thinking.insert(reference.to_string(), level);
            }
        })
    }

    fn change_selection(&self, change: impl FnOnce(&mut Selection)) -> Result<(), LlmError> {
        let mut selection = (*self.selection()).clone();
        selection.version = 1;
        change(&mut selection);
        if let Some(dir) = &self.dir {
            crate::discovery::write_json(&dir.join("selection.json"), &selection)?;
        }
        *self.selection.write() = Some(Arc::new(selection));
        Ok(())
    }
}

/// One model over the layers: public catalog, the provider's list, the written entry, defaults.
fn build(
    provider: &ProviderConfig,
    id: &str,
    public: Option<&PublicModel>,
    listed: Option<&ListedModel>,
    entry: Option<&ModelToml>,
) -> DirectoryModel {
    let mut lower = public.map(public_layer).unwrap_or_else(|| ModelToml { id: id.to_string(), ..Default::default() });
    if let Some(listed) = listed {
        merge_model(&mut lower, list_layer(listed));
    }
    let top = entry.cloned().unwrap_or_else(|| ModelToml { id: id.to_string(), ..Default::default() });
    let mut model = provider.build_model(Some(&lower), &top);
    // Long-context prices are the catalog's, in dollars; a price set above replaces them all.
    if let Some(public) = public
        && provider.plan.is_none()
        && model.currency == Currency::Usd
        && lower.cost == public.cost
        && top.cost.is_none()
        && listed.is_none_or(|l| l.cost.is_none())
    {
        model.cost_tiers = public.cost_tiers.clone();
    }
    let meta = ModelMeta {
        known: public.is_some() || listed.is_some_and(ListedModel::has_details) || entry.is_some(),
        deprecated: public.is_some_and(|p| p.deprecated),
        released: public.and_then(|p| p.released.clone()),
        configured: entry.is_some(),
        chat: entry.is_some()
            || (public.is_none_or(PublicModel::is_chat) && listed.is_none_or(|l| l.tool_call != Some(false))),
    };
    DirectoryModel { model: Arc::new(model), meta }
}

fn public_layer(p: &PublicModel) -> ModelToml {
    let (thinking, thinking_budgets) = derive_thinking(&p.reasoning_options);
    ModelToml {
        id: p.id.clone(),
        name: p.name.clone(),
        context_window: p.context_window,
        max_output_tokens: p.max_output_tokens,
        reasoning: p.reasoning,
        thinking,
        thinking_budgets,
        input: (!p.input.is_empty()).then(|| {
            if p.input.iter().any(|i| i == "image") {
                vec![Modality::Text, Modality::Image]
            } else {
                vec![Modality::Text]
            }
        }),
        cost: p.cost.clone().filter(|c| c.is_configured()),
        currency: Some(Currency::Usd),
        ..Default::default()
    }
}

fn list_layer(l: &ListedModel) -> ModelToml {
    ModelToml {
        id: l.id.clone(),
        name: l.name.clone(),
        context_window: l.context_window,
        max_output_tokens: l.max_output_tokens,
        reasoning: l.reasoning,
        input: l.images.map(|images| if images { vec![Modality::Text, Modality::Image] } else { vec![Modality::Text] }),
        currency: l.cost.as_ref().map(|_| Currency::Usd),
        cost: l.cost.clone().filter(|c| c.is_configured()),
        ..Default::default()
    }
}

/// The levels a model offers, and its budgets, from the catalog's reasoning options (§18):
/// the provider's own effort values (`none` is "off"); a token budget offers the effort levels
/// at finx's budgets; a switch alone offers off and on. Values finx has no level for are left
/// out.
pub fn derive_thinking(options: &[ReasoningOption]) -> (Option<Vec<ThinkingLevel>>, Option<ThinkingBudgets>) {
    use ThinkingLevel::*;
    let toggle = options.contains(&ReasoningOption::Toggle);
    let effort = options.iter().find_map(|o| match o {
        ReasoningOption::Effort { values } => Some(values),
        _ => None,
    });
    let budget = options.iter().find_map(|o| match o {
        ReasoningOption::BudgetTokens { min, max } => Some((*min, *max)),
        _ => None,
    });
    let budgets = budget.filter(|(min, max)| min.is_some() || max.is_some()).map(|(min, max)| {
        let clamp = |default: u32| Some(default.max(min.unwrap_or(0)).min(max.unwrap_or(u32::MAX)));
        ThinkingBudgets {
            minimal: clamp(1_024),
            low: clamp(4_096),
            medium: clamp(10_240),
            high: clamp(24_576),
            xhigh: clamp(28_672),
            max: clamp(32_768),
        }
    });
    let mut levels: Vec<ThinkingLevel> = Vec::new();
    if let Some(values) = effort {
        for value in values {
            match value.as_str() {
                "none" => levels.push(Off),
                other => levels.extend(other.parse::<ThinkingLevel>().ok().filter(|l| l.is_effort())),
            }
        }
    }
    if !levels.is_empty() {
        if toggle {
            levels.push(Off);
        }
    } else if budget.is_some() {
        levels = vec![Off, Low, Medium, High, Max];
    } else if toggle {
        levels = vec![Off, On];
    } else {
        return (None, budgets);
    }
    levels.sort();
    levels.dedup();
    (Some(levels), budgets)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::Catalog;
    use crate::catalog::Listing;
    use crate::discovery::ModelList;
    use crate::model::ModelCost;

    fn effort(values: &[&str]) -> Vec<ReasoningOption> {
        vec![ReasoningOption::Effort { values: values.iter().map(|v| v.to_string()).collect() }]
    }

    fn levels(options: &[ReasoningOption]) -> Vec<ThinkingLevel> {
        derive_thinking(options).0.unwrap()
    }

    #[test]
    fn effort_values_are_the_levels() {
        use ThinkingLevel::*;
        assert_eq!(levels(&effort(&["low", "high", "max"])), [Low, High, Max]);
        assert_eq!(levels(&effort(&["none", "low", "medium", "high", "xhigh"])), [Off, Low, Medium, High, Xhigh]);
        assert_eq!(levels(&effort(&["low", "turbo"])), [Low], "values finx has no level for are left out");
        assert_eq!(levels(&effort(&["none"])), [Off]);
    }

    #[test]
    fn switches_and_budgets() {
        use ThinkingLevel::*;
        assert_eq!(levels(&[ReasoningOption::Toggle]), [Off, On]);
        // DeepSeek: a switch and three efforts.
        assert_eq!(levels(&[ReasoningOption::Toggle, effort(&["low", "high", "max"])[0].clone()]), [Off, Low, High, Max]);
        let (budget_levels, budgets) = derive_thinking(&[ReasoningOption::BudgetTokens { min: Some(2_048), max: Some(16_000) }]);
        assert_eq!(budget_levels.unwrap(), [Off, Low, Medium, High, Max]);
        let budgets = budgets.unwrap();
        assert_eq!((budgets.minimal, budgets.high), (Some(2_048), Some(16_000)));
        assert_eq!(derive_thinking(&[]), (None, None));
    }

    fn provider(entries: Vec<ModelToml>) -> ProviderConfig {
        let mut p = Catalog::from_toml(
            r#"
            [providers.p]
            api = "openai-chat"
            base_url = "https://example.invalid/v1"
            api_key_env = "P_KEY"
            currency = "CNY"
            catalog_id = "deepseek"
            compat = { thinking_format = "deepseek" }
            "#,
        )
        .unwrap()
        .providers
        .remove("p")
        .unwrap();
        p.listing.entries = entries;
        p
    }

    fn public_model(id: &str, released: &str) -> PublicModel {
        PublicModel {
            id: id.into(),
            name: Some(format!("Public {id}")),
            context_window: Some(64_000),
            max_output_tokens: Some(8_000),
            reasoning: Some(true),
            reasoning_options: effort(&["low", "high"]),
            input: vec!["text".into()],
            released: Some(released.into()),
            cost: Some(ModelCost { input: 1.0, output: 2.0, ..Default::default() }),
            ..Default::default()
        }
    }

    #[test]
    fn layers_merge_field_by_field() {
        let p = provider(vec![ModelToml {
            id: "a".into(),
            name: Some("Written".into()),
            cost: Some(ModelCost { input: 7.0, output: 8.0, ..Default::default() }),
            ..Default::default()
        }]);
        let listed = ListedModel { id: "a".into(), context_window: Some(99_000), ..Default::default() };
        let built = build(&p, "a", Some(&public_model("a", "2026-01-01")), Some(&listed), p.listing.entries.first());
        let m = &built.model;
        assert_eq!(m.name, "Written");
        assert_eq!(m.context_window, 99_000, "the list's window beats the catalog's");
        assert_eq!(m.max_output_tokens, 8_000, "the catalog fills what the others leave");
        assert!(m.reasoning);
        assert_eq!(m.thinking, [ThinkingLevel::Low, ThinkingLevel::High]);
        assert_eq!((m.cost.input, m.currency), (7.0, Currency::Cny), "a written price is in the provider's currency");
        assert!(built.meta.known && built.meta.configured);
        let plain = build(&p, "b", Some(&public_model("b", "2026-01-01")), None, None);
        assert_eq!((plain.model.cost.input, plain.model.currency), (1.0, Currency::Usd), "catalog prices are dollars");
        let unknown = build(&p, "c", None, Some(&ListedModel { id: "c".into(), ..Default::default() }), None);
        assert!(!unknown.meta.known);
        assert_eq!(unknown.model.context_window, crate::model::DEFAULT_CONTEXT_WINDOW);
        let refuses_tools = build(&p, "d", None, Some(&ListedModel { id: "d".into(), tool_call: Some(false), ..Default::default() }), None);
        assert!(!refuses_tools.meta.chat);
    }

    #[test]
    fn the_list_decides_which_models_exist() {
        let dir = tempfile::tempdir().unwrap();
        let directory = ModelDirectory::new(Some(dir.path().to_path_buf()));
        let p = provider(vec![ModelToml { id: "mine".into(), ..Default::default() }]);
        // No list yet: the catalog's models, and the written one.
        let from_catalog = directory.models(&p);
        assert_eq!(from_catalog.source, IdSource::Catalog);
        assert!(from_catalog.get("deepseek-flash").is_some() && from_catalog.get("mine").is_some());
        let list = ModelList {
            version: 1,
            fetched_at: Some(crate::discovery::now()),
            checked_at: crate::discovery::now(),
            source: ListSource::Provider,
            credential: None,
            error: None,
            models: vec![ListedModel { id: "deepseek-flash".into(), ..Default::default() }, ListedModel { id: "brand-new".into(), ..Default::default() }],
        };
        crate::discovery::write_json(&dir.path().join("lists/p.json"), &list).unwrap();
        directory.invalidate();
        let listed = directory.models(&p);
        assert_eq!(listed.source, IdSource::Provider);
        let ids: Vec<_> = listed.models.iter().map(|m| m.model.id.as_str()).collect();
        assert_eq!(ids, ["deepseek-flash", "brand-new", "mine"]);
        assert!(listed.get("deepseek-flash").unwrap().meta.known);
        assert!(!listed.get("brand-new").unwrap().meta.known);
        // A provider sharing the list reads the same file.
        let mut alternate = provider(vec![]);
        alternate.id = "alt".into();
        alternate.listing = Listing { from: Some("p".into()), catalog_id: Some("deepseek".into()), ..Default::default() };
        assert_eq!(directory.models(&alternate).models.len(), 2);
    }

    #[test]
    fn plans_use_only_their_own_membership_and_never_public_prices() {
        let dir = tempfile::tempdir().unwrap();
        let directory = ModelDirectory::new(Some(dir.path().to_path_buf()));
        let mut p = provider(vec![ModelToml { id: "deepseek-flash".into(), ..Default::default() }]);
        p.plan = Some(crate::catalog::PlanConfig { key_url: "https://example.invalid/plan".into() });
        let seeds = directory.models(&p);
        assert_eq!(seeds.source, IdSource::Config);
        assert_eq!(seeds.models.len(), 1, "do not import the full API catalog");
        let m = &seeds.get("deepseek-flash").unwrap().model;
        assert!(m.context_window > 100_000, "still enrich model capabilities");
        assert!(!m.cost.is_configured());
        assert!(m.cost_tiers.is_empty());
        directory.invalidate();
        assert!(directory.model(&p, "deepseek-v4-pro").is_none(), "single-model lookup also respects plan membership");

        let mut list = ModelList {
            version: 1, fetched_at: Some(crate::discovery::now()), checked_at: crate::discovery::now(),
            source: ListSource::Provider, credential: None, error: None,
            models: vec![ListedModel { id: "new-plan-model".into(), ..Default::default() }],
        };
        crate::discovery::write_json(&dir.path().join("lists/p.json"), &list).unwrap();
        directory.invalidate();
        let live = directory.models(&p);
        assert_eq!(live.source, IdSource::Provider);
        assert_eq!(live.models.len(), 1);
        assert!(live.get("new-plan-model").is_some());
        assert!(directory.model(&p, "deepseek-flash").is_none(), "removed seeds stay removed");

        list.models.clear();
        crate::discovery::write_json(&dir.path().join("lists/p.json"), &list).unwrap();
        directory.invalidate();
        assert!(directory.models(&p).models.is_empty(), "an empty successful list is authoritative too");
    }

    #[test]
    fn default_shown_is_the_newest_known_models() {
        let p = provider(vec![ModelToml { id: "mine".into(), ..Default::default() }]);
        let mut models: Vec<DirectoryModel> = (0..20)
            .map(|i| build(&p, &format!("m{i:02}"), Some(&public_model(&format!("m{i:02}"), &format!("2026-01-{:02}", i + 1))), None, None))
            .collect();
        let mut old = public_model("old", "2026-12-31");
        old.deprecated = true;
        models.push(build(&p, "old", Some(&old), None, None));
        models.push(build(&p, "unknown", None, None, None));
        models.push(build(&p, "mine", None, None, p.listing.entries.first()));
        let pm = ProviderModels { source: IdSource::Catalog, list: None, models };
        let shown = pm.default_shown(false);
        assert_eq!(shown.len(), DEFAULT_SHOWN);
        assert!(shown.contains("mine") && shown.contains("m19") && !shown.contains("m08"));
        assert!(!shown.contains("old") && !shown.contains("unknown"));
        assert_eq!(pm.default_shown(true), BTreeSet::from(["mine".to_string()]));
    }

    #[test]
    fn selection_keeps_only_changes() {
        let dir = tempfile::tempdir().unwrap();
        let directory = ModelDirectory::new(Some(dir.path().to_path_buf()));
        directory.set_shown("p/a", false, true).unwrap();
        directory.set_shown("p/b", true, false).unwrap();
        directory.set_shown("p/c", true, true).unwrap();
        let reread = ModelDirectory::new(Some(dir.path().to_path_buf())).selection();
        assert_eq!(reread.hide, BTreeSet::from(["p/a".to_string()]));
        assert_eq!(reread.show, BTreeSet::from(["p/b".to_string()]));
        assert!(!reread.is_shown("p/a", true) && reread.is_shown("p/b", false) && reread.is_shown("p/new", true));
        directory.set_shown("p/a", true, true).unwrap();
        assert!(directory.selection().hide.is_empty());
    }
}
