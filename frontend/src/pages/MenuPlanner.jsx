import { useEffect, useMemo, useState } from "react";
import axios from "axios";

const MEALS = [
  { key: "breakfast", label: "Petit-déjeuner" },
  { key: "lunch", label: "Déjeuner" },
  { key: "dinner", label: "Dîner" },
];

const ITEM_TYPES = ["Viennoiserie", "Entrée", "Plat principal", "Dessert", "Boisson", "Autre"];
const weekdayFormatter = new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "short" });

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

const normalizePlan = (weekStart, rawDays = {}) => {
  const normalized = {};
  buildWeekDates(weekStart).forEach((day) => {
    normalized[day] = {
      breakfast: rawDays[day]?.breakfast ?? [],
      lunch: rawDays[day]?.lunch ?? [],
      dinner: rawDays[day]?.dinner ?? [],
    };
  });
  return normalized;
};

const generateId = () => Math.random().toString(36).slice(2, 10);

function MenuPlanner() {
  const [weekStart, setWeekStart] = useState(() => getWeekStart());
  const [selectedDate, setSelectedDate] = useState(() => toISODate(getWeekStart()));
  const [recipes, setRecipes] = useState([]);
  const [planDays, setPlanDays] = useState(() => normalizePlan(getWeekStart()));
  const [grocerySections, setGrocerySections] = useState([]);
  const [aisleMapping, setAisleMapping] = useState({});

  const [importPayload, setImportPayload] = useState("");
  const [csvImportPayload, setCsvImportPayload] = useState("name,category,ingredients,steps\nPancakes,Petit-déjeuner,Farine|200|g;Lait|300|ml,Mélanger|Cuire");
  const [xlsxFile, setXlsxFile] = useState(null);

  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const [recipeForm, setRecipeForm] = useState({
    name: "",
    category: "Plat principal",
    ingredientsText: "",
    stepsText: "",
  });

  const [mealForm, setMealForm] = useState({
    label: "",
    item_type: "Plat principal",
    recipe_id: "",
  });

  const weekDates = useMemo(() => buildWeekDates(weekStart), [weekStart]);

  const loadRecipes = async () => {
    const { data } = await axios.get("/api/recipes");
    setRecipes(data);
  };

  const loadPlan = async (startDate) => {
    const weekStartISO = toISODate(startDate);
    const { data } = await axios.get("/api/menu-plan", { params: { week_start: weekStartISO } });
    setPlanDays(normalizePlan(startDate, data.days));
    setSelectedDate((prev) => (data.days[prev] ? prev : weekStartISO));
  };

  const loadGroceryList = async (startDate = weekStart) => {
    const { data } = await axios.get("/api/grocery-list", { params: { week_start: toISODate(startDate) } });
    setGrocerySections(data.sections ?? []);
  };

  const loadAisleMapping = async () => {
    const { data } = await axios.get("/api/aisle-mapping");
    setAisleMapping(data || {});
  };

  useEffect(() => {
    const init = async () => {
      try {
        setError("");
        await loadRecipes();
        await loadPlan(weekStart);
        await loadGroceryList(weekStart);
        await loadAisleMapping();
      } catch (err) {
        setError(err.response?.data?.detail || "Impossible de charger les données.");
      }
    };
    init();
  }, []);

  const savePlan = async (nextPlanDays) => {
    try {
      setSaving(true);
      setError("");
      await axios.put(`/api/menu-plan/${toISODate(weekStart)}`, { days: nextPlanDays });
      setPlanDays(nextPlanDays);
      await loadGroceryList();
    } catch (err) {
      setError(err.response?.data?.detail || "Erreur lors de la sauvegarde du planning.");
    } finally {
      setSaving(false);
    }
  };

  const changeWeek = async (offset) => {
    const nextWeek = new Date(weekStart);
    nextWeek.setDate(nextWeek.getDate() + offset * 7);

    try {
      setWeekStart(nextWeek);
      setSelectedDate(toISODate(nextWeek));
      await loadPlan(nextWeek);
      await loadGroceryList(nextWeek);
    } catch (err) {
      setError(err.response?.data?.detail || "Impossible de changer de semaine.");
    }
  };

  const createRecipe = async (event) => {
    event.preventDefault();
    const ingredients = recipeForm.ingredientsText
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [name, quantity, unit] = line.split(";").map((part) => part.trim());
        return { name, quantity: Number(quantity), unit };
      });

    const steps = recipeForm.stepsText
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    if (!recipeForm.name || ingredients.some((item) => !item.name || Number.isNaN(item.quantity) || !item.unit) || steps.length === 0) {
      setError("Recette invalide: respecte le format ingrédients 'nom;quantité;unité' et ajoute des étapes.");
      return;
    }

    try {
      setError("");
      await axios.post("/api/recipes", { name: recipeForm.name, category: recipeForm.category, ingredients, steps });
      setRecipeForm({ name: "", category: "Plat principal", ingredientsText: "", stepsText: "" });
      await loadRecipes();
    } catch (err) {
      setError(err.response?.data?.detail || "Impossible de créer la recette.");
    }
  };

  const importRecipes = async () => {
    try {
      const parsed = JSON.parse(importPayload);
      if (!Array.isArray(parsed)) {
        setError("Import invalide: il faut un tableau JSON de recettes.");
        return;
      }
      setError("");
      await axios.post("/api/recipes/import", { recipes: parsed });
      setImportPayload("");
      await loadRecipes();
    } catch (err) {
      setError(err.response?.data?.detail || "Import JSON impossible.");
    }
  };

  const importRecipesCsv = async () => {
    try {
      setError("");
      await axios.post("/api/recipes/import/csv", { csv_text: csvImportPayload });
      await loadRecipes();
    } catch (err) {
      setError(err.response?.data?.detail || "Import CSV impossible.");
    }
  };

  const importRecipesXlsx = async () => {
    if (!xlsxFile) {
      setError("Sélectionne un fichier Excel avant import.");
      return;
    }

    try {
      setError("");
      const formData = new FormData();
      formData.append("file", xlsxFile);
      await axios.post("/api/recipes/import/xlsx", formData, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      await loadRecipes();
    } catch (err) {
      setError(err.response?.data?.detail || "Import Excel impossible.");
    }
  };

  const saveAisleMapping = async () => {
    try {
      setError("");
      await axios.put("/api/aisle-mapping", { mapping: aisleMapping });
      await loadGroceryList();
      await loadAisleMapping();
    } catch (err) {
      setError(err.response?.data?.detail || "Impossible de sauvegarder les rayons.");
    }
  };

  const updateAisleKeywords = (section, value) => {
    const keywords = value
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean);
    setAisleMapping((prev) => ({ ...prev, [section]: keywords }));
  };

  const downloadGroceryPdf = () => {
    const weekStartIso = toISODate(weekStart);
    window.open(`/api/grocery-list/pdf?week_start=${weekStartIso}`, "_blank");
  };

  const addMealItem = async (mealKey) => {
    if (!selectedDate) return;

    const selectedRecipe = recipes.find((recipe) => recipe.id === mealForm.recipe_id);
    const label = mealForm.label || selectedRecipe?.name;

    if (!label) {
      setError("Ajoute un libellé ou sélectionne une recette.");
      return;
    }

    const item = { id: generateId(), label, item_type: mealForm.item_type, recipe_id: mealForm.recipe_id || null };
    const nextPlanDays = {
      ...planDays,
      [selectedDate]: {
        ...planDays[selectedDate],
        [mealKey]: [...planDays[selectedDate][mealKey], item],
      },
    };

    setMealForm({ label: "", item_type: "Plat principal", recipe_id: "" });
    await savePlan(nextPlanDays);
  };

  const removeMealItem = async (mealKey, itemId) => {
    const nextPlanDays = {
      ...planDays,
      [selectedDate]: {
        ...planDays[selectedDate],
        [mealKey]: planDays[selectedDate][mealKey].filter((item) => item.id !== itemId),
      },
    };

    await savePlan(nextPlanDays);
  };

  return (
    <main className="planner-page">
      <header className="planner-header">
        <h1>Planification des menus familiaux</h1>
        <p>Base de recettes, plan hebdomadaire / journalier, courses auto + export PDF.</p>
      </header>

      {error && <p className="error-banner">{error}</p>}

      <section className="planner-grid">
        <article className="card two-col">
          <h2>Vue semaine</h2>
          <div className="week-actions">
            <button onClick={() => changeWeek(-1)}>Semaine précédente</button>
            <strong>{toISODate(weekStart)}</strong>
            <button onClick={() => changeWeek(1)}>Semaine suivante</button>
          </div>
          <div className="week-days">
            {weekDates.map((isoDate) => (
              <button key={isoDate} className={`day-button ${selectedDate === isoDate ? "active" : ""}`} onClick={() => setSelectedDate(isoDate)}>
                <span>{weekdayFormatter.format(new Date(`${isoDate}T00:00:00`))}</span>
                <small>{MEALS.reduce((total, meal) => total + (planDays[isoDate]?.[meal.key]?.length ?? 0), 0)} item(s)</small>
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
                {(planDays[selectedDate]?.[meal.key] ?? []).map((item) => (
                  <li key={item.id}>
                    <div>
                      <strong>{item.label}</strong>
                      <small>{item.item_type}</small>
                    </div>
                    <button onClick={() => removeMealItem(meal.key, item.id)}>Supprimer</button>
                  </li>
                ))}
              </ul>
              <div className="inline-form">
                <input placeholder="Libellé (optionnel si recette)" value={mealForm.label} onChange={(event) => setMealForm((prev) => ({ ...prev, label: event.target.value }))} />
                <select value={mealForm.item_type} onChange={(event) => setMealForm((prev) => ({ ...prev, item_type: event.target.value }))}>
                  {ITEM_TYPES.map((type) => (
                    <option key={type} value={type}>{type}</option>
                  ))}
                </select>
                <select value={mealForm.recipe_id} onChange={(event) => setMealForm((prev) => ({ ...prev, recipe_id: event.target.value }))}>
                  <option value="">Sans recette</option>
                  {recipes.map((recipe) => (
                    <option key={recipe.id} value={recipe.id}>{recipe.name}</option>
                  ))}
                </select>
                <button onClick={() => addMealItem(meal.key)} disabled={saving}>Ajouter</button>
              </div>
            </div>
          ))}
        </article>

        <article className="card">
          <h2>Créer une recette</h2>
          <form onSubmit={createRecipe} className="stack-form">
            <input value={recipeForm.name} onChange={(event) => setRecipeForm((prev) => ({ ...prev, name: event.target.value }))} placeholder="Nom de la recette" required />
            <input value={recipeForm.category} onChange={(event) => setRecipeForm((prev) => ({ ...prev, category: event.target.value }))} placeholder="Catégorie" />
            <textarea value={recipeForm.ingredientsText} onChange={(event) => setRecipeForm((prev) => ({ ...prev, ingredientsText: event.target.value }))} placeholder={"Ingrédients (1 par ligne)\nformat: nom;quantité;unité"} rows={5} />
            <textarea value={recipeForm.stepsText} onChange={(event) => setRecipeForm((prev) => ({ ...prev, stepsText: event.target.value }))} placeholder={"Étapes (1 par ligne)"} rows={5} />
            <button type="submit">Enregistrer la recette</button>
          </form>
        </article>

        <article className="card">
          <h2>Importer des recettes</h2>
          <p className="helper">JSON, CSV et Excel doivent contenir: name, category, ingredients, steps.</p>
          <textarea value={importPayload} onChange={(event) => setImportPayload(event.target.value)} rows={6} placeholder="JSON: [{...}]" />
          <button onClick={importRecipes}>Importer JSON</button>
          <textarea value={csvImportPayload} onChange={(event) => setCsvImportPayload(event.target.value)} rows={6} />
          <button onClick={importRecipesCsv}>Importer CSV</button>
          <input type="file" accept=".xlsx,.xls" onChange={(event) => setXlsxFile(event.target.files?.[0] || null)} />
          <button onClick={importRecipesXlsx}>Importer Excel</button>
        </article>

        <article className="card two-col">
          <h2>Recettes & pas-à-pas</h2>
          <div className="recipe-list">
            {recipes.map((recipe) => (
              <details key={recipe.id}>
                <summary>{recipe.name} <small>({recipe.category})</small></summary>
                <p><strong>Ingrédients:</strong> {recipe.ingredients.map((item) => `${item.name} ${item.quantity} ${item.unit}`).join(", ")}</p>
                <ol>{recipe.steps.map((step) => <li key={step}>{step}</li>)}</ol>
              </details>
            ))}
          </div>
        </article>

        <article className="card two-col">
          <h2>Liste de courses (auto)</h2>
          <div className="inline-form">
            <button onClick={() => loadGroceryList()}>Régénérer</button>
            <button onClick={downloadGroceryPdf}>Exporter PDF</button>
          </div>
          <ul className="grocery-list">
            {grocerySections.length === 0 && <li>Aucune course: ajoute des recettes dans les repas de la semaine.</li>}
            {grocerySections.map((section) => (
              <li key={section.section}>
                <strong>{section.section}</strong>
                <ul>
                  {section.items.map((item) => (
                    <li key={`${section.section}-${item.name}-${item.unit}`}>{item.name}: {item.quantity} {item.unit}</li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </article>

        <article className="card two-col">
          <h2>Configuration des rayons</h2>
          <p className="helper">Mots-clés séparés par virgules pour classer automatiquement les ingrédients.</p>
          <div className="stack-form">
            {Object.entries(aisleMapping).map(([section, keywords]) => (
              <label key={section}>
                <strong>{section}</strong>
                <textarea rows={2} value={keywords.join(", ")} onChange={(event) => updateAisleKeywords(section, event.target.value)} />
              </label>
            ))}
          </div>
          <button onClick={saveAisleMapping}>Sauvegarder les rayons</button>
        </article>
      </section>
    </main>
  );
}

export default MenuPlanner;
