from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Dict, List, Literal, Optional
import logging
import os
import uuid

from dotenv import load_dotenv
from fastapi import APIRouter, FastAPI, HTTPException, Query
from motor.motor_asyncio import AsyncIOMotorClient
from pydantic import BaseModel, ConfigDict, Field
from starlette.middleware.cors import CORSMiddleware

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / ".env")

mongo_url = os.environ["MONGO_URL"]
client = AsyncIOMotorClient(mongo_url)
db = client[os.environ["DB_NAME"]]

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


MealType = Literal["breakfast", "lunch", "dinner"]


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


class GroceryListResponse(BaseModel):
    week_start: date
    items: List[GroceryItem]


@api_router.get("/")
async def root():
    return {"message": "Menu Planner API"}


@api_router.post("/status", response_model=StatusCheck)
async def create_status_check(input: StatusCheckCreate):
    status_obj = StatusCheck(**input.model_dump())
    doc = status_obj.model_dump()
    doc["timestamp"] = doc["timestamp"].isoformat()

    _ = await db.status_checks.insert_one(doc)
    return status_obj


@api_router.get("/status", response_model=List[StatusCheck])
async def get_status_checks():
    status_checks = await db.status_checks.find({}, {"_id": 0}).to_list(1000)
    for check in status_checks:
        if isinstance(check["timestamp"], str):
            check["timestamp"] = datetime.fromisoformat(check["timestamp"])
    return status_checks


@api_router.get("/recipes", response_model=List[Recipe])
async def get_recipes():
    docs = await db.recipes.find({}, {"_id": 0}).sort("name", 1).to_list(1000)
    for recipe in docs:
        if isinstance(recipe.get("created_at"), str):
            recipe["created_at"] = datetime.fromisoformat(recipe["created_at"])
    return docs


@api_router.post("/recipes", response_model=Recipe)
async def create_recipe(payload: RecipeCreate):
    recipe = Recipe(**payload.model_dump())
    doc = recipe.model_dump()
    doc["created_at"] = doc["created_at"].isoformat()
    await db.recipes.insert_one(doc)
    return recipe


@api_router.post("/recipes/import", response_model=List[Recipe])
async def import_recipes(payload: RecipeImportPayload):
    created: List[Recipe] = []
    docs = []
    for raw_recipe in payload.recipes:
        recipe = Recipe(**raw_recipe.model_dump())
        created.append(recipe)
        doc = recipe.model_dump()
        doc["created_at"] = doc["created_at"].isoformat()
        docs.append(doc)

    if docs:
        await db.recipes.insert_many(docs)

    return created


def week_dates(week_start: date) -> List[str]:
    return [(week_start + timedelta(days=offset)).isoformat() for offset in range(7)]


@api_router.get("/menu-plan", response_model=MenuPlan)
async def get_menu_plan(week_start: date = Query(..., description="Lundi de la semaine")):
    doc = await db.menu_plans.find_one({"week_start": week_start.isoformat()}, {"_id": 0})
    if doc:
        if isinstance(doc.get("updated_at"), str):
            doc["updated_at"] = datetime.fromisoformat(doc["updated_at"])
        return doc

    default_days = {day: DayMeals().model_dump() for day in week_dates(week_start)}
    return MenuPlan(week_start=week_start, days=default_days)


@api_router.put("/menu-plan/{week_start}", response_model=MenuPlan)
async def update_menu_plan(week_start: date, payload: MenuPlanUpdate):
    expected_dates = set(week_dates(week_start))
    provided_dates = set(payload.days.keys())
    if not expected_dates.issubset(provided_dates):
        raise HTTPException(status_code=400, detail="Les 7 jours de la semaine doivent être fournis.")

    plan = MenuPlan(week_start=week_start, days=payload.days)
    doc = plan.model_dump()
    doc["week_start"] = week_start.isoformat()
    doc["updated_at"] = doc["updated_at"].isoformat()

    await db.menu_plans.update_one(
        {"week_start": week_start.isoformat()},
        {"$set": doc},
        upsert=True,
    )
    return plan


@api_router.get("/grocery-list", response_model=GroceryListResponse)
async def get_grocery_list(week_start: date = Query(..., description="Lundi de la semaine")):
    plan_doc = await db.menu_plans.find_one({"week_start": week_start.isoformat()}, {"_id": 0})
    if not plan_doc:
        return GroceryListResponse(week_start=week_start, items=[])

    recipe_ids: set[str] = set()
    for day in plan_doc.get("days", {}).values():
        for meal_key in ["breakfast", "lunch", "dinner"]:
            for item in day.get(meal_key, []):
                if item.get("recipe_id"):
                    recipe_ids.add(item["recipe_id"])

    if not recipe_ids:
        return GroceryListResponse(week_start=week_start, items=[])

    recipes = await db.recipes.find({"id": {"$in": list(recipe_ids)}}, {"_id": 0}).to_list(1000)
    aggregated: Dict[tuple[str, str], float] = {}

    for recipe in recipes:
        for ingredient in recipe.get("ingredients", []):
            key = (ingredient["name"].strip().lower(), ingredient["unit"].strip().lower())
            aggregated[key] = aggregated.get(key, 0.0) + float(ingredient["quantity"])

    items = [
        GroceryItem(name=name.title(), unit=unit, quantity=round(quantity, 2))
        for (name, unit), quantity in sorted(aggregated.items(), key=lambda x: x[0][0])
    ]
    return GroceryListResponse(week_start=week_start, items=items)


app.include_router(api_router)

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=os.environ.get("CORS_ORIGINS", "*").split(","),
    allow_methods=["*"],
    allow_headers=["*"],
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)


@app.on_event("shutdown")
async def shutdown_db_client():
    client.close()
