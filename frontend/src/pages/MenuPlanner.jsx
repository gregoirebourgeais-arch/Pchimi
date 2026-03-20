import { useEffect, useMemo, useState } from "react";

const MEALS = [
  { key: "breakfast", label: "Petit-déjeuner" },
  { key: "lunch", label: "Déjeuner" },
  { key: "dinner", label: "Dîner" },
];

const ITEM_TYPES = ["Viennoiserie", "Entrée", "Plat principal", "Dessert", "Boisson", "Autre"];
const STORAGE_KEY = "menu_planner_local_v2";

const DEFAULT_AISLES = {
  "Fruits & légumes": ["tomate", "pomme", "banane", "carotte", "salade", "oignon", "ail", "courgette"],
  "Boucherie / Poisson": ["poulet", "boeuf", "porc", "saumon", "thon", "dinde", "jambon"],
  "Produits frais": ["lait", "beurre", "crème", "yaourt", "fromage", "oeuf", "œuf"],
  "Épicerie": ["farine", "riz", "pâtes", "pates", "sucre", "huile", "vinaigre", "sel", "poivre"],
  Boulangerie: ["pain", "baguette", "croissant", "brioche"],
  Surgelés: ["surgelé", "surgeles"],
  Autres: [],
};

const weekdayFormatter = new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "short" });
const generateId = () => Math.random().toString(36).slice(2, 10);

const getWeekStart = (input = new Date()) => {
  const date = new Date(input);
  const day = date.getDay() || 7;
  date.setHours(0, 0, 0, 0);
  if (day !== 1) date.setDate(date.getDate() - (day - 1));
  return date;
};

const toISODate = (date) => {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const buildWeekDates = (weekStart) => {
  const dates = [];
  for (let offset = 0; offset < 7; offset += 1) {
    const date = new Date(weekStart);
    date.setDate(date.getDate() + offset);
    dates.push(toISODate(date));
  }
  return dates;
};

const createEmptyDays = (weekStartIso) => {
  const startDate = new Date(`${weekStartIso}T00:00:00`);
  return buildWeekDates(startDate).reduce((acc, isoDate) => {
    acc[isoDate] = { breakfast: [], lunch: [], dinner: [] };
    return acc;
  }, {});
};

const detectSection = (name, mapping) => {
  const lower = name.toLowerCase();
  for (const [section, keywords] of Object.entries(mapping)) {
    if (section === "Autres") continue;
    if (keywords.some((keyword) => lower.includes(keyword.toLowerCase()))) return section;
  }
  return "Autres";
};

const mergeData = (localData, importedData) => {
  const localRecipes = localData.recipes || [];
  const importedRecipes = importedData.recipes || [];
  const recipeByName = new Map(localRecipes.map((r) => [r.name.trim().toLowerCase(), r]));
  const mergedRecipes = [...localRecipes];

  importedRecipes.forEach((recipe) => {
    const key = recipe.name?.trim().toLowerCase();
    if (!key) return;
    if (!recipeByName.has(key)) {
      const copy = { ...recipe, id: recipe.id || generateId() };
      mergedRecipes.push(copy);
      recipeByName.set(key, copy);
    }
  });

  const mergedPlans = { ...(localData.plansByWeek || {}) };
  Object.entries(importedData.plansByWeek || {}).forEach(([week, days]) => {
    if (!mergedPlans[week]) {
      mergedPlans[week] = days;
      return;
    }

    const nextDays = { ...mergedPlans[week] };
    Object.entries(days || {}).forEach(([day, meals]) => {
      nextDays[day] = nextDays[day] || { breakfast: [], lunch: [], dinner: [] };
      ["breakfast", "lunch", "dinner"].forEach((mealKey) => {
        const localItems = nextDays[day][mealKey] || [];
        const importedItems = meals?.[mealKey] || [];
        nextDays[day][mealKey] = [...localItems, ...importedItems.map((item) => ({ ...item, id: item.id || generateId() }))];
      });
    });
    mergedPlans[week] = nextDays;
  });

  const mergedAisles = { ...(localData.aisleMapping || {}), ...(importedData.aisleMapping || {}) };
  return { recipes: mergedRecipes, plansByWeek: mergedPlans, aisleMapping: mergedAisles };
};

function MenuPlanner() {
  const [weekStart, setWeekStart] = useState(() => getWeekStart());
  const [selectedDate, setSelectedDate] = useState(() => toISODate(getWeekStart()));
  const [recipes, setRecipes] = useState([]);
  const [plansByWeek, setPlansByWeek] = useState({});
  const [aisleMapping, setAisleMapping] = useState(DEFAULT_AISLES);
  const [error, setError] = useState("");
  const [importFile, setImportFile] = useState(null);
  const [recipeForm, setRecipeForm] = useState({ name: "", category: "Plat principal", ingredientsText: "", stepsText: "" });
  const [mealForm, setMealForm] = useState({ label: "", item_type: "Plat principal", recipe_id: "" });
  const [newSectionName, setNewSectionName] = useState("");

  const weekStartIso = useMemo(() => toISODate(weekStart), [weekStart]);
  const weekDates = useMemo(() => buildWeekDates(weekStart), [weekStart]);
  const currentWeekPlan = plansByWeek[weekStartIso] ?? createEmptyDays(weekStartIso);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      setRecipes(parsed.recipes ?? []);
      setPlansByWeek(parsed.plansByWeek ?? {});
      setAisleMapping(parsed.aisleMapping ?? DEFAULT_AISLES);
    } catch {
      setError("Impossible de lire les données locales.");
    }
  }, []);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ recipes, plansByWeek, aisleMapping }));
  }, [recipes, plansByWeek, aisleMapping]);

  const grocerySections = useMemo(() => {
    const ids = new Set();
    Object.values(currentWeekPlan).forEach((day) => {
      MEALS.forEach((meal) => day[meal.key].forEach((item) => item.recipe_id && ids.add(item.recipe_id)));
    });

    const aggregated = {};
    recipes.forEach((recipe) => {
      if (!ids.has(recipe.id)) return;
      recipe.ingredients.forEach((ingredient) => {
        const key = `${ingredient.name.toLowerCase()}||${ingredient.unit.toLowerCase()}`;
        aggregated[key] = (aggregated[key] ?? 0) + Number(ingredient.quantity);
      });
    });

    const grouped = {};
    Object.entries(aggregated).forEach(([key, quantity]) => {
      const [name, unit] = key.split("||");
      const section = detectSection(name, aisleMapping);
      grouped[section] = grouped[section] ?? [];
      grouped[section].push({ name: name[0].toUpperCase() + name.slice(1), unit, quantity: Number(quantity.toFixed(2)) });
    });

    return Object.entries(grouped).map(([section, items]) => ({ section, items })).sort((a, b) => a.section.localeCompare(b.section));
  }, [currentWeekPlan, recipes, aisleMapping]);

  const saveCurrentWeekPlan = (nextWeekPlan) => setPlansByWeek((prev) => ({ ...prev, [weekStartIso]: nextWeekPlan }));

  const createRecipe = (event) => {
    event.preventDefault();
    const ingredients = recipeForm.ingredientsText.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => {
      const [name, quantity, unit] = line.split(";").map((part) => part.trim());
      return { name, quantity: Number(quantity), unit };
    });
    const steps = recipeForm.stepsText.split("\n").map((line) => line.trim()).filter(Boolean);

    if (!recipeForm.name || ingredients.some((i) => !i.name || Number.isNaN(i.quantity) || !i.unit) || steps.length === 0) {
      setError("Recette invalide.");
      return;
    }

    setRecipes((prev) => [...prev, { id: generateId(), name: recipeForm.name, category: recipeForm.category, ingredients, steps }]);
    setRecipeForm({ name: "", category: "Plat principal", ingredientsText: "", stepsText: "" });
    setError("");
  };

  const addMealItem = (mealKey) => {
    const selectedRecipe = recipes.find((recipe) => recipe.id === mealForm.recipe_id);
    const label = mealForm.label || selectedRecipe?.name;
    if (!label) return;

    const item = { id: generateId(), label, item_type: mealForm.item_type, recipe_id: mealForm.recipe_id || null };
    const nextPlan = {
      ...currentWeekPlan,
      [selectedDate]: { ...currentWeekPlan[selectedDate], [mealKey]: [...currentWeekPlan[selectedDate][mealKey], item] },
    };
    saveCurrentWeekPlan(nextPlan);
    setMealForm({ label: "", item_type: "Plat principal", recipe_id: "" });
  };

  const removeMealItem = (mealKey, itemId) => {
    const nextPlan = {
      ...currentWeekPlan,
      [selectedDate]: { ...currentWeekPlan[selectedDate], [mealKey]: currentWeekPlan[selectedDate][mealKey].filter((item) => item.id !== itemId) },
    };
    saveCurrentWeekPlan(nextPlan);
  };

  const exportData = () => {
    const payload = { version: 2, exportedAt: new Date().toISOString(), recipes, plansByWeek, aisleMapping };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `menu-planner-export-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const readImportFile = async () => {
    if (!importFile) throw new Error("missing");
    const parsed = JSON.parse(await importFile.text());
    if (!Array.isArray(parsed.recipes) || typeof parsed.plansByWeek !== "object") throw new Error("format");
    return parsed;
  };

  const importDataReplace = async () => {
    const ok = window.confirm("Attention: cette action va écraser toutes les données locales (recettes, planning, rayons). Continuer ?");
    if (!ok) return;

    try {
      const parsed = await readImportFile();
      setRecipes(parsed.recipes || []);
      setPlansByWeek(parsed.plansByWeek || {});
      setAisleMapping(parsed.aisleMapping || DEFAULT_AISLES);
      setError("");
    } catch {
      setError("Import impossible: fichier invalide.");
    }
  };

  const importDataMerge = async () => {
    try {
      const parsed = await readImportFile();
      const merged = mergeData({ recipes, plansByWeek, aisleMapping }, parsed);
      setRecipes(merged.recipes);
      setPlansByWeek(merged.plansByWeek);
      setAisleMapping(merged.aisleMapping);
      setError("");
    } catch {
      setError("Fusion impossible: fichier invalide.");
    }
  };

  const prepareEmail = () => {
    const subject = encodeURIComponent("Export Menu Planner");
    const body = encodeURIComponent("Bonjour,\n\nJe t'envoie le fichier JSON d'export Menu Planner en pièce jointe.\n");
    window.location.href = `mailto:?subject=${subject}&body=${body}`;
  };

  const changeWeek = (offset) => {
    const nextWeek = new Date(weekStart);
    nextWeek.setDate(nextWeek.getDate() + offset * 7);
    setWeekStart(nextWeek);
    setSelectedDate(toISODate(nextWeek));
  };

  const updateAisleKeywords = (section, value) => {
    setAisleMapping((prev) => ({ ...prev, [section]: value.split(",").map((i) => i.trim().toLowerCase()).filter(Boolean) }));
  };

  const addAisleSection = () => {
    const name = newSectionName.trim();
    if (!name || aisleMapping[name]) return;
    setAisleMapping((prev) => ({ ...prev, [name]: [] }));
    setNewSectionName("");
  };

  const removeAisleSection = (section) => {
    if (section === "Autres") return;
    setAisleMapping((prev) => {
      const clone = { ...prev };
      delete clone[section];
      return clone;
    });
  };

  return (
    <main className="planner-page">
      <header className="planner-header">
        <h1>Planification des menus familiaux (100% local)</h1>
        <p>Partage des données par export JSON (email) sans backend obligatoire.</p>
      </header>

      {error && <p className="error-banner">{error}</p>}

      <section className="planner-grid">
        <article className="card two-col">
          <h2>Vue semaine</h2>
          <div className="week-actions">
            <button onClick={() => changeWeek(-1)}>Semaine précédente</button>
            <strong>{weekStartIso}</strong>
            <button onClick={() => changeWeek(1)}>Semaine suivante</button>
          </div>
          <div className="week-days">
            {weekDates.map((isoDate) => (
              <button key={isoDate} className={`day-button ${selectedDate === isoDate ? "active" : ""}`} onClick={() => setSelectedDate(isoDate)}>
                <span>{weekdayFormatter.format(new Date(`${isoDate}T00:00:00`))}</span>
                <small>{MEALS.reduce((total, meal) => total + (currentWeekPlan[isoDate]?.[meal.key]?.length ?? 0), 0)} item(s)</small>
              </button>
            ))}
          </div>
        </article>

        <article className="card two-col">
          <h2>Vue jour: {selectedDate}</h2>
          {MEALS.map((meal) => (
            <div key={meal.key} className="meal-section">
              <h3>{meal.label}</h3>
              <ul>
                {(currentWeekPlan[selectedDate]?.[meal.key] ?? []).map((item) => (
                  <li key={item.id}>
                    <div><strong>{item.label}</strong><small>{item.item_type}</small></div>
                    <button onClick={() => removeMealItem(meal.key, item.id)}>Supprimer</button>
                  </li>
                ))}
              </ul>
              <div className="inline-form">
                <input placeholder="Libellé (optionnel si recette)" value={mealForm.label} onChange={(e) => setMealForm((p) => ({ ...p, label: e.target.value }))} />
                <select value={mealForm.item_type} onChange={(e) => setMealForm((p) => ({ ...p, item_type: e.target.value }))}>
                  {ITEM_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
                </select>
                <select value={mealForm.recipe_id} onChange={(e) => setMealForm((p) => ({ ...p, recipe_id: e.target.value }))}>
                  <option value="">Sans recette</option>
                  {recipes.map((recipe) => <option key={recipe.id} value={recipe.id}>{recipe.name}</option>)}
                </select>
                <button onClick={() => addMealItem(meal.key)}>Ajouter</button>
              </div>
            </div>
          ))}
        </article>

        <article className="card">
          <h2>Créer une recette</h2>
          <form onSubmit={createRecipe} className="stack-form">
            <input value={recipeForm.name} onChange={(e) => setRecipeForm((p) => ({ ...p, name: e.target.value }))} placeholder="Nom de la recette" required />
            <input value={recipeForm.category} onChange={(e) => setRecipeForm((p) => ({ ...p, category: e.target.value }))} placeholder="Catégorie" />
            <textarea value={recipeForm.ingredientsText} onChange={(e) => setRecipeForm((p) => ({ ...p, ingredientsText: e.target.value }))} placeholder={"Ingrédients (1 par ligne)\nformat: nom;quantité;unité"} rows={5} />
            <textarea value={recipeForm.stepsText} onChange={(e) => setRecipeForm((p) => ({ ...p, stepsText: e.target.value }))} placeholder={"Étapes (1 par ligne)"} rows={5} />
            <button type="submit">Enregistrer la recette</button>
          </form>
        </article>

        <article className="card">
          <h2>Export / Import (email)</h2>
          <p className="helper">Tu peux remplacer les données locales ou les fusionner.</p>
          <div className="inline-form">
            <button onClick={exportData}>Exporter mes données</button>
            <button onClick={prepareEmail}>Préparer email</button>
          </div>
          <input type="file" accept="application/json,.json" onChange={(e) => setImportFile(e.target.files?.[0] || null)} />
          <div className="inline-form">
            <button onClick={importDataReplace}>Importer (remplacer)</button>
            <button onClick={importDataMerge}>Importer (fusionner)</button>
          </div>
        </article>

        <article className="card two-col">
          <h2>Recettes & pas-à-pas</h2>
          <div className="recipe-list">
            {recipes.map((recipe) => (
              <details key={recipe.id}>
                <summary>{recipe.name} <small>({recipe.category})</small></summary>
                <p><strong>Ingrédients:</strong> {recipe.ingredients.map((i) => `${i.name} ${i.quantity} ${i.unit}`).join(", ")}</p>
                <ol>{recipe.steps.map((step) => <li key={step}>{step}</li>)}</ol>
              </details>
            ))}
          </div>
        </article>

        <article className="card two-col">
          <h2>Liste de courses (auto)</h2>
          <ul className="grocery-list">
            {grocerySections.length === 0 && <li>Aucune course: ajoute des recettes dans les repas de la semaine.</li>}
            {grocerySections.map((section) => (
              <li key={section.section}><strong>{section.section}</strong><ul>{section.items.map((item) => <li key={`${section.section}-${item.name}-${item.unit}`}>{item.name}: {item.quantity} {item.unit}</li>)}</ul></li>
            ))}
          </ul>
        </article>

        <article className="card two-col">
          <h2>Configuration des rayons</h2>
          <div className="stack-form">
            {Object.entries(aisleMapping).map(([section, keywords]) => (
              <label key={section}>
                <div className="inline-form"><strong>{section}</strong><button type="button" onClick={() => removeAisleSection(section)} disabled={section === "Autres"}>Supprimer</button></div>
                <textarea rows={2} value={keywords.join(", ")} onChange={(e) => updateAisleKeywords(section, e.target.value)} />
              </label>
            ))}
          </div>
          <div className="inline-form"><input value={newSectionName} onChange={(e) => setNewSectionName(e.target.value)} placeholder="Nouveau rayon" /><button type="button" onClick={addAisleSection}>Ajouter rayon</button></div>
        </article>
      </section>
    </main>
  );
}

export default MenuPlanner;
