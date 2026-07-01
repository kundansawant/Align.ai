import os
import uvicorn
from fastapi import FastAPI, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional
import memory_engine

app = FastAPI(
    title="Align.ai Backend API",
    description="Bridge API between the Align.ai VS Code extension and Cognee Memory Graph",
    version="1.0.0"
)

# Configure CORS so extension and webviews can make requests
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Startup event to initialize Cognee framework
@app.on_event("startup")
async def startup_event():
    success = await memory_engine.init_cognee()
    if success:
        print("Cognee initialized successfully on backend startup.")
    else:
        print("Cognee initialization completed with warnings/fallback mode.")

# Pydantic request models
class RememberRequest(BaseModel):
    text_or_file_content: str
    file_path: Optional[str] = None
    dataset_name: Optional[str] = "main_dataset"

class RecallRequest(BaseModel):
    query_prompt: str
    dataset_name: Optional[str] = "main_dataset"

class ForgetRequest(BaseModel):
    dataset_name: Optional[str] = "main_dataset"

@app.get("/status")
async def get_status():
    """
    Returns the backend system and Cognee initialization status.
    """
    mode = "Cloud" if memory_engine.is_cloud else "Local"
    return {
        "status": "online",
        "cognee_available": memory_engine.COGNEE_AVAILABLE,
        "cognee_mode": mode,
        "service_url": memory_engine.COGNEE_SERVICE_URL if memory_engine.is_cloud else "Local Storage"
    }

@app.post("/remember")
async def remember_endpoint(payload: RememberRequest):
    """
    Endpoint to ingest code files, layout configurations, or styling guidelines into Cognee.
    """
    result = await memory_engine.remember(
        text_or_file_content=payload.text_or_file_content,
        file_path=payload.file_path,
        dataset_name=payload.dataset_name
    )
    if result["status"] == "error":
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=result["message"]
        )
    return result

@app.post("/recall")
async def recall_endpoint(payload: RecallRequest):
    """
    Endpoint to query Cognee memory and retrieve context-aware design guardrails.
    """
    result = await memory_engine.recall(
        query_prompt=payload.query_prompt,
        dataset_name=payload.dataset_name
    )
    if result["status"] == "error":
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=result["message"]
        )
    return result

@app.post("/forget")
async def forget_endpoint(payload: ForgetRequest):
    """
    Endpoint to clear or prune a specific dataset's memory graph.
    """
    result = await memory_engine.forget(
        dataset_name=payload.dataset_name
    )
    if result["status"] == "error":
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=result["message"]
        )
    return result

if __name__ == "__main__":
    port = int(os.getenv("PORT", 8000))
    print(f"Starting Align.ai backend server on port {port}...")
    uvicorn.run("server:app", host="127.0.0.1", port=port, reload=True)
