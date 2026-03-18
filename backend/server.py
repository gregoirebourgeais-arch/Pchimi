from __future__ import annotations

import csv
import json
import logging
import os
import sqlite3
import threading
import uuid
from datetime import date, datetime, timedelta, timezone
from io import BytesIO, StringIO
from pathlib import Path
from typing import Dict, List, Optional

import pandas as pd
from dotenv import load_dotenv
from fastapi import APIRouter, FastAPI, File, HTTPException, Query, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict, Field
from starlette.middleware.cors import CORSMiddleware

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / ".env")

DATABASE_PATH = Path(os.environ.get("SQLITE_PATH", ROOT_DIR / "menu_planner.db"))
db_lock = threading.Lock()

DEFAULT_AISLE_MAPPING: dict[str, list[str]] = {
    "Fruits & légumes": ["tomate", "pomme", "banane", "carotte", "salade", "oignon", "ail", "courgette"],
    "Boucherie / Poisson": ["poulet", "boeuf", "porc", "saumon", "thon", "dinde", "jambon"],
    "Produits frais": ["lait", "beurre", "crème", "yaourt", "fromage", "oeuf", "œuf"],
    "Épicerie": ["farine", "riz", "pâtes", "pates", "sucre", "huile", "vinaigre", "sel", "poivre"],
    "Boulangerie": ["pain", "baguette", "croissant", "brioche"],
    "Surgelés": ["surgelé", "surgeles"],
    "Autres": [],
}

app = FastAPI()
api_router = APIRouter(prefix="/api")


class StatusCheck(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    client_name: str
    timestamp: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class StatusCheckCreate(BaseModel):
    client_name: str


class Ingredient(BaseModel):
    name: str
    quantity: float = Field(gt=0)
    unit: str


class Recipe(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    name: str
    category: str = "Plat principal"
    ingredients: List[Ingredient]
    steps: List[str] = Field(min_length=1)
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class RecipeCreate(BaseModel):
    name: str
    category: str = "Plat principal"
    ingredients: List[Ingredient]
    steps: List[str] = Field(min_length=1)


class RecipeImportPayload(BaseModel):
    recipes: List[RecipeCreate]


class RecipeCsvImportPayload(BaseModel):
    csv_text: str


class MealItem(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    label: str
    item_type: str = "Plat principal"
    recipe_id: Optional[str] = None


class DayMeals(BaseModel):
    breakfast: List[MealItem] = Field(default_factory=list)
    lunch: List[MealItem] = Field(default_factory=list)
    dinner: List[MealItem] = Field(default_factory=list)


class MenuPlan(BaseModel):
    model_config = ConfigDict(extra="ignore")

    week_start: date
    days: Dict[str, DayMeals]
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class MenuPlanUpdate(BaseModel):
    days: Dict[str, DayMeals]


class GroceryItem(BaseModel):
    name: str
    quantity: float
    unit: str


class GrocerySection(BaseModel):
    section: str
    items: List[GroceryItem]


class GroceryListResponse(BaseModel):
    week_start: date
    sections: List[GrocerySection]


class AisleMappingPayload(BaseModel):
    mapping: Dict[str, List[str]]


def get_connection() -> sqlite3.Connection:
    connection = sqlite3.connect(DATABASE_PATH)
    connection.row_factory = sqlite3.Row
    return connection


def init_db() -> None:
    with db_lock:
        with get_connection() as connection:
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS recipes (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    category TEXT NOT NULL,
                    ingredients_json TEXT NOT NULL,
                    steps_json TEXT NOT NULL,
                    created_at TEXT NOT NULL
                )
                """
            )
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS menu_plans (
                    week_start TEXT PRIMARY KEY,
                    days_json TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )
                """
            )
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS status_checks (
                    id TEXT PRIMARY KEY,
                    client_name TEXT NOT NULL,
                    timestamp TEXT NOT NULL
                )
                """
            )
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS settings (
                    key TEXT PRIMARY KEY,
                    value_json TEXT NOT NULL
                )
                """
            )
            connection.execute(
                "INSERT OR IGNORE INTO settings (key, value_json) VALUES (?, ?)",
                ("aisle_mapping", json.dumps(DEFAULT_AISLE_MAPPING, ensure_ascii=False)),
            )


def week_dates(week_start: date) -> List[str]:
    return [(week_start + timedelta(days=offset)).isoformat() for offset in range(7)]


def serialize_recipe(recipe: Recipe) -> dict:
    data = recipe.model_dump()
    data["created_at"] = recipe.created_at.isoformat()
    data["ingredients_json"] = json.dumps([ingredient.model_dump() for ingredient in recipe.ingredients], ensure_ascii=False)
    data["steps_json"] = json.dumps(recipe.steps, ensure_ascii=False)
    return data


def row_to_recipe(row: sqlite3.Row) -> Recipe:
    return Recipe(
        id=row["id"],
        name=row["name"],
        category=row["category"],
        ingredients=json.loads(row["ingredients_json"]),
        steps=json.loads(row["steps_json"]),
        created_at=datetime.fromisoformat(row["created_at"]),
    )


def parse_recipe_cells(ingredients_cell: str, steps_cell: str) -> tuple[List[Ingredient], List[str]]:
    ingredients: List[Ingredient] = []
    for chunk in [part.strip() for part in ingredients_cell.split(";") if part.strip()]:
        parts = [item.strip() for item in chunk.split("|")]
        if len(parts) != 3:
            raise ValueError("Format ingrédient invalide, attendu: nom|quantité|unité")
        ingredients.append(Ingredient(name=parts[0], quantity=float(parts[1]), unit=parts[2]))

    steps = [step.strip() for step in steps_cell.split("|") if step.strip()]
    if not ingredients or not steps:
        raise ValueError("Ingrédients ou étapes manquants")

    return ingredients, steps


def load_aisle_mapping() -> dict[str, list[str]]:
    with db_lock:
        with get_connection() as connection:
            row = connection.execute("SELECT value_json FROM settings WHERE key = ?", ("aisle_mapping",)).fetchone()
    if not row:
        return DEFAULT_AISLE_MAPPING
    raw = json.loads(row["value_json"])
    return {section: [keyword.lower().strip() for keyword in keywords if keyword.strip()] for section, keywords in raw.items()}


def detect_section(ingredient_name: str, mapping: dict[str, list[str]]) -> str:
    name = ingredient_name.lower()
    for section, keywords in mapping.items():
        if section == "Autres":
            continue
        if any(keyword in name for keyword in keywords):
            return section
    return "Autres"


def build_simple_pdf(title: str, lines: list[str]) -> bytes:
    escaped_lines = [line.replace("(", "[").replace(")", "]") for line in lines]
    y = 780
    content_parts = ["BT /F1 16 Tf 50 810 Td ({}) Tj ET".format(title)]
    for line in escaped_lines:
        line_clean = line.encode("latin-1", "replace").decode("latin-1")
        content_parts.append(f"BT /F1 11 Tf 50 {y} Td ({line_clean}) Tj ET")
        y -= 16
        if y < 60:
            break

    content_stream = "\n".join(content_parts).encode("latin-1", "replace")

    objects = []
    objects.append(b"1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n")
    objects.append(b"2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n")
    objects.append(b"3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >> endobj\n")
    objects.append(b"4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n")
    objects.append(f"5 0 obj << /Length {len(content_stream)} >> stream\n".encode("latin-1") + content_stream + b"\nendstream endobj\n")

    pdf = bytearray(b"%PDF-1.4\n")
    xref_positions = [0]
    for obj in objects:
        xref_positions.append(len(pdf))
        pdf.extend(obj)

    xref_start = len(pdf)
    pdf.extend(f"xref\n0 {len(xref_positions)}\n".encode("latin-1"))
    pdf.extend(b"0000000000 65535 f \n")
    for pos in xref_positions[1:]:
        pdf.extend(f"{pos:010} 00000 n \n".encode("latin-1"))

    pdf.extend(
        f"trailer << /Size {len(xref_positions)} /Root 1 0 R >>\nstartxref\n{xref_start}\n%%EOF".encode("latin-1")
    )
    return bytes(pdf)


def parse_table_records(records: list[dict]) -> list[Recipe]:
    created: List[Recipe] = []
    for row in records:
        ingredients, steps = parse_recipe_cells(str(row.get("ingredients", "")), str(row.get("steps", "")))
        recipe = Recipe(
            name=str(row.get("name", "")).strip(),
            category=(str(row.get("category", "Plat principal")).strip() or "Plat principal"),
            ingredients=ingredients,
            steps=steps,
        )
        if not recipe.name:
            raise HTTPException(status_code=400, detail="Chaque recette doit avoir un nom")
        created.append(recipe)
    return created


@api_router.get("/")
async def root():
    return {"message": "Menu Planner API (local SQLite)"}


@api_router.post("/status", response_model=StatusCheck)
async def create_status_check(input: StatusCheckCreate):
    status = StatusCheck(**input.model_dump())
    with db_lock:
        with get_connection() as connection:
            connection.execute(
                "INSERT INTO status_checks (id, client_name, timestamp) VALUES (?, ?, ?)",
                (status.id, status.client_name, status.timestamp.isoformat()),
            )
    return status


@api_router.get("/status", response_model=List[StatusCheck])
async def get_status_checks():
    with db_lock:
        with get_connection() as connection:
            rows = connection.execute("SELECT id, client_name, timestamp FROM status_checks ORDER BY timestamp DESC LIMIT 1000").fetchall()
    return [StatusCheck(id=row["id"], client_name=row["client_name"], timestamp=datetime.fromisoformat(row["timestamp"])) for row in rows]


@api_router.get("/aisle-mapping", response_model=Dict[str, List[str]])
async def get_aisle_mapping():
    return load_aisle_mapping()


@api_router.put("/aisle-mapping", response_model=Dict[str, List[str]])
async def update_aisle_mapping(payload: AisleMappingPayload):
    clean_mapping = {
        section.strip(): [keyword.strip().lower() for keyword in keywords if keyword.strip()]
        for section, keywords in payload.mapping.items()
        if section.strip()
    }
    if "Autres" not in clean_mapping:
        clean_mapping["Autres"] = []

    with db_lock:
        with get_connection() as connection:
            connection.execute(
                "INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json",
                ("aisle_mapping", json.dumps(clean_mapping, ensure_ascii=False)),
            )
    return clean_mapping


@api_router.get("/recipes", response_model=List[Recipe])
async def get_recipes():
    with db_lock:
        with get_connection() as connection:
            rows = connection.execute("SELECT * FROM recipes ORDER BY name ASC").fetchall()
    return [row_to_recipe(row) for row in rows]


@api_router.post("/recipes", response_model=Recipe)
async def create_recipe(payload: RecipeCreate):
    recipe = Recipe(**payload.model_dump())
    serialized = serialize_recipe(recipe)
    with db_lock:
        with get_connection() as connection:
            connection.execute(
                "INSERT INTO recipes (id, name, category, ingredients_json, steps_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                (
                    serialized["id"],
                    serialized["name"],
                    serialized["category"],
                    serialized["ingredients_json"],
                    serialized["steps_json"],
                    serialized["created_at"],
                ),
            )
    return recipe


@api_router.post("/recipes/import", response_model=List[Recipe])
async def import_recipes(payload: RecipeImportPayload):
    created = [Recipe(**entry.model_dump()) for entry in payload.recipes]
    with db_lock:
        with get_connection() as connection:
            for recipe in created:
                serialized = serialize_recipe(recipe)
                connection.execute(
                    "INSERT INTO recipes (id, name, category, ingredients_json, steps_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                    (
                        serialized["id"],
                        serialized["name"],
                        serialized["category"],
                        serialized["ingredients_json"],
                        serialized["steps_json"],
                        serialized["created_at"],
                    ),
                )
    return created


@api_router.post("/recipes/import/csv", response_model=List[Recipe])
async def import_recipes_csv(payload: RecipeCsvImportPayload):
    csv_text = payload.csv_text.strip()
    if not csv_text:
        raise HTTPException(status_code=400, detail="CSV vide")

    delimiter = ";" if csv_text.splitlines()[0].count(";") >= csv_text.splitlines()[0].count(",") else ","
    reader = csv.DictReader(StringIO(csv_text), delimiter=delimiter)
    expected_fields = {"name", "category", "ingredients", "steps"}
    if not reader.fieldnames or not expected_fields.issubset(set(field.strip() for field in reader.fieldnames)):
        raise HTTPException(status_code=400, detail="Colonnes requises: name, category, ingredients, steps")

    created = parse_table_records(list(reader))
    with db_lock:
        with get_connection() as connection:
            for recipe in created:
                serialized = serialize_recipe(recipe)
                connection.execute(
                    "INSERT INTO recipes (id, name, category, ingredients_json, steps_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                    (
                        serialized["id"],
                        serialized["name"],
                        serialized["category"],
                        serialized["ingredients_json"],
                        serialized["steps_json"],
                        serialized["created_at"],
                    ),
                )
    return created


@api_router.post("/recipes/import/xlsx", response_model=List[Recipe])
async def import_recipes_xlsx(file: UploadFile = File(...)):
    if not file.filename or not file.filename.lower().endswith((".xlsx", ".xls")):
        raise HTTPException(status_code=400, detail="Fichier Excel requis (.xlsx ou .xls)")

    content = await file.read()
    try:
        dataframe = pd.read_excel(BytesIO(content))
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Impossible de lire le fichier Excel: {exc}") from exc

    expected_columns = {"name", "category", "ingredients", "steps"}
    if not expected_columns.issubset(set(map(str, dataframe.columns))):
        raise HTTPException(status_code=400, detail="Colonnes requises dans le fichier Excel: name, category, ingredients, steps")

    records = dataframe.fillna("").to_dict(orient="records")
    created = parse_table_records(records)
    with db_lock:
        with get_connection() as connection:
            for recipe in created:
                serialized = serialize_recipe(recipe)
                connection.execute(
                    "INSERT INTO recipes (id, name, category, ingredients_json, steps_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                    (
                        serialized["id"],
                        serialized["name"],
                        serialized["category"],
                        serialized["ingredients_json"],
                        serialized["steps_json"],
                        serialized["created_at"],
                    ),
                )
    return created


@api_router.get("/menu-plan", response_model=MenuPlan)
async def get_menu_plan(week_start: date = Query(..., description="Lundi de la semaine")):
    with db_lock:
        with get_connection() as connection:
            row = connection.execute(
                "SELECT week_start, days_json, updated_at FROM menu_plans WHERE week_start = ?",
                (week_start.isoformat(),),
            ).fetchone()

    if row:
        return MenuPlan(
            week_start=date.fromisoformat(row["week_start"]),
            days=json.loads(row["days_json"]),
            updated_at=datetime.fromisoformat(row["updated_at"]),
        )

    default_days = {day: DayMeals().model_dump() for day in week_dates(week_start)}
    return MenuPlan(week_start=week_start, days=default_days)


@api_router.put("/menu-plan/{week_start}", response_model=MenuPlan)
async def update_menu_plan(week_start: date, payload: MenuPlanUpdate):
    expected_dates = set(week_dates(week_start))
    provided_dates = set(payload.days.keys())
    if not expected_dates.issubset(provided_dates):
        raise HTTPException(status_code=400, detail="Les 7 jours de la semaine doivent être fournis.")

    plan = MenuPlan(week_start=week_start, days=payload.days)
    with db_lock:
        with get_connection() as connection:
            connection.execute(
                """
                INSERT INTO menu_plans (week_start, days_json, updated_at)
                VALUES (?, ?, ?)
                ON CONFLICT(week_start) DO UPDATE SET
                    days_json = excluded.days_json,
                    updated_at = excluded.updated_at
                """,
                (week_start.isoformat(), json.dumps(payload.days, ensure_ascii=False), plan.updated_at.isoformat()),
            )
    return plan


def compute_grocery_sections(week_start: date) -> List[GrocerySection]:
    with db_lock:
        with get_connection() as connection:
            plan_row = connection.execute(
                "SELECT days_json FROM menu_plans WHERE week_start = ?",
                (week_start.isoformat(),),
            ).fetchone()

    if not plan_row:
        return []

    days = json.loads(plan_row["days_json"])
    recipe_ids: set[str] = set()
    for day in days.values():
        for meal_key in ["breakfast", "lunch", "dinner"]:
            for item in day.get(meal_key, []):
                if item.get("recipe_id"):
                    recipe_ids.add(item["recipe_id"])

    if not recipe_ids:
        return []

    placeholders = ",".join("?" for _ in recipe_ids)
    with db_lock:
        with get_connection() as connection:
            rows = connection.execute(f"SELECT * FROM recipes WHERE id IN ({placeholders})", tuple(recipe_ids)).fetchall()

    aggregated: Dict[tuple[str, str], float] = {}
    for row in rows:
        ingredients = json.loads(row["ingredients_json"])
        for ingredient in ingredients:
            key = (ingredient["name"].strip().lower(), ingredient["unit"].strip().lower())
            aggregated[key] = aggregated.get(key, 0.0) + float(ingredient["quantity"])

    mapping = load_aisle_mapping()
    grouped: Dict[str, List[GroceryItem]] = {}
    for (name, unit), quantity in sorted(aggregated.items(), key=lambda entry: entry[0][0]):
        section = detect_section(name, mapping)
        grouped.setdefault(section, []).append(GroceryItem(name=name.title(), quantity=round(quantity, 2), unit=unit))

    return [GrocerySection(section=section, items=items) for section, items in sorted(grouped.items(), key=lambda entry: entry[0])]


@api_router.get("/grocery-list", response_model=GroceryListResponse)
async def get_grocery_list(week_start: date = Query(..., description="Lundi de la semaine")):
    sections = compute_grocery_sections(week_start)
    return GroceryListResponse(week_start=week_start, sections=sections)


@api_router.get("/grocery-list/pdf")
async def get_grocery_list_pdf(week_start: date = Query(..., description="Lundi de la semaine")):
    sections = compute_grocery_sections(week_start)
    lines: list[str] = []
    for section in sections:
        lines.append(f"[{section.section}]")
        for item in section.items:
            lines.append(f"- {item.name}: {item.quantity} {item.unit}")
        lines.append("")

    if not lines:
        lines = ["Aucune course pour cette semaine"]

    pdf_bytes = build_simple_pdf(f"Liste de courses - {week_start.isoformat()}", lines)
    filename = f"liste-courses-{week_start.isoformat()}.pdf"
    return StreamingResponse(
        BytesIO(pdf_bytes),
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


app.include_router(api_router)
app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=os.environ.get("CORS_ORIGINS", "*").split(","),
    allow_methods=["*"],
    allow_headers=["*"],
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(name)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)


@app.on_event("startup")
async def startup_event():
    init_db()
