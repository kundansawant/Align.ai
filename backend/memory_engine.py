import os
import logging
from dotenv import load_dotenv

# Setup logging
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
logger = logging.getLogger("AlignAI_MemoryEngine")

# Load environment variables from .env
load_dotenv()

# Attempt to import cognee
try:
    import cognee
    COGNEE_AVAILABLE = True
except ImportError:
    cognee = None
    COGNEE_AVAILABLE = False
    logger.error("Cognee SDK is not installed. Please run: pip install -r requirements.txt")

COGNEE_API_KEY = os.getenv("COGNEE_API_KEY", "")
COGNEE_SERVICE_URL = os.getenv("COGNEE_SERVICE_URL", "https://platform.cognee.ai")

is_cloud = False
if COGNEE_API_KEY and COGNEE_API_KEY != "your_cognee_cloud_key_here":
    is_cloud = True

async def init_cognee():
    """
    Initializes the Cognee framework. Connects to Cognee Cloud if a valid API key is present,
    otherwise runs in Local Mode.
    """
    if not COGNEE_AVAILABLE:
        logger.warning("Cognee is unavailable. Operations will run in mock/fallback mode.")
        return False
    
    if is_cloud:
        logger.info(f"Initializing Cognee Cloud at URL: {COGNEE_SERVICE_URL}")
        try:
            # Connect to Cognee Cloud
            await cognee.serve(api_key=COGNEE_API_KEY, url=COGNEE_SERVICE_URL)
            logger.info("Cognee Cloud successfully initialized!")
            return True
        except Exception as e:
            logger.error(f"Failed to connect to Cognee Cloud: {e}. Falling back to Local Mode.")
            return False
    else:
        logger.info("Initializing Cognee in Local Mode (no active COGNEE_API_KEY detected).")
        # In local mode, Cognee runs on SQLite & Local Vector DB (Kuzu + Qdrant/LanceDB/etc. by default)
        return True

async def remember(text_or_file_content: str, file_path: str = None, dataset_name: str = "main_dataset"):
    """
    Ingests file content, styling rules, or naming conventions into Cognee's hybrid store.
    """
    if not COGNEE_AVAILABLE:
        logger.warning(f"Mock Remember: file={file_path}, content_len={len(text_or_file_content)}")
        return {
            "status": "success",
            "message": "[Mock Mode] Content received. Ingestion skipped because Cognee is not installed."
        }
        
    try:
        content_to_store = text_or_file_content
        if file_path:
            content_to_store = f"File Path: {file_path}\nContent:\n{text_or_file_content}"
            
        logger.info(f"Ingesting memory into dataset '{dataset_name}' (length: {len(content_to_store)} characters)...")
        
        await cognee.remember(
            content_to_store,
            dataset_id=dataset_name
        )
        
        logger.info(f"Ingestion successful for dataset '{dataset_name}'!")
        return {
            "status": "success",
            "message": f"Successfully ingested rules/code into memory for dataset '{dataset_name}'."
        }
    except Exception as e:
        logger.error(f"Error in remember: {e}", exc_info=True)
        return {
            "status": "error",
            "message": f"Failed to ingest content into Cognee: {str(e)}"
        }

async def recall(query_prompt: str, dataset_name: str = "main_dataset"):
    """
    Queries Cognee's graph-vector store to pull styling constraints and naming rules,
    structuring a prompt payload for the LLM.
    """
    if not COGNEE_AVAILABLE:
        logger.warning(f"Mock Recall for query: {query_prompt}")
        mock_payload = (
            "--- UI DESIGN & CODING ALIGNMENT GUARDRAILS ---\n"
            "1. [Mock Rule] Target Resolution: 1280x720 (Desktop viewport limit).\n"
            "2. [Mock Rule] Apple-style minimalist spacing: Padding values must be factors of 8px (e.g., 8px, 16px, 24px, 32px).\n"
            "3. [Mock Rule] Typography: Use Inter or Outfit. Headings must be bold/semibold with slight letter-spacing reduction (-0.02em).\n"
            "4. [Mock Rule] Naming Conventions: CamelCase for TypeScript components (e.g., PrimaryButton), kebab-case for CSS classes.\n\n"
            "--- TASK CONTEXT ---\n"
            f"Developer task or query: {query_prompt}\n\n"
            "Please follow these guidelines strictly. Validate that the current code matches these specs."
        )
        return {
            "status": "success",
            "recalled_texts": [
                "Target Resolution: 1280x720",
                "Apple-style minimalist spacing (8px grid)",
                "Typography: Use Inter or Outfit"
            ],
            "prompt_payload": mock_payload
        }

    try:
        logger.info(f"Recalling memory for query '{query_prompt}' from dataset '{dataset_name}'...")
        
        results = await cognee.recall(
            query_text=query_prompt,
            datasets=[dataset_name]
        )
        
        recalled_texts = []
        if results:
            for r in results:
                if hasattr(r, "text"):
                    recalled_texts.append(r.text)
                else:
                    recalled_texts.append(str(r))
                    
        # Structure the prompt payload for the LLM
        prompt_payload = (
            "--- UI DESIGN & CODING ALIGNMENT GUARDRAILS ---\n"
            "The following historic styling constraints and codebase naming conventions were retrieved from Cognee memory:\n\n"
        )
        
        if recalled_texts:
            for idx, text in enumerate(recalled_texts, 1):
                prompt_payload += f"{idx}. {text}\n"
        else:
            # Fallback to standard guidelines if no specific context is found
            prompt_payload += (
                "1. Screen Viewport: Target Resolution should be 1280x720.\n"
                "2. Layout Padding: 16px standard, 24px container padding.\n"
                "3. Premium Aesthetic: Glassmorphism, Outfit/Inter typography, clean micro-shadows.\n"
                "4. Naming Conventions: TSX files use PascalCase, styles use kebab-case.\n"
            )
            
        prompt_payload += (
            "\n--- TASK CONTEXT ---\n"
            f"Developer task or query: {query_prompt}\n\n"
            "Please verify that the component fits within these layout constraints and conventions. "
            "Flag any padding, color, or structural drift from our design system."
        )
        
        logger.info(f"Recall successful! Retrieved {len(recalled_texts)} entries.")
        return {
            "status": "success",
            "recalled_texts": recalled_texts,
            "prompt_payload": prompt_payload
        }
    except Exception as e:
        logger.error(f"Error in recall: {e}", exc_info=True)
        return {
            "status": "error",
            "message": f"Failed to recall content from Cognee: {str(e)}"
        }

async def forget(dataset_name: str = "main_dataset"):
    """
    Surgically prunes the memory graph of the specified dataset.
    """
    if not COGNEE_AVAILABLE:
        logger.warning(f"Mock Forget dataset: {dataset_name}")
        return {
            "status": "success",
            "message": f"[Mock Mode] Dataset '{dataset_name}' mock-pruned successfully."
        }
        
    try:
        logger.info(f"Emptying dataset '{dataset_name}' from Cognee...")
        await cognee.datasets.empty_dataset(dataset_id=dataset_name)
        logger.info(f"Dataset '{dataset_name}' pruned successfully.")
        return {
            "status": "success",
            "message": f"Dataset '{dataset_name}' has been successfully pruned and cleared from Cognee store."
        }
    except Exception as e:
        logger.error(f"Error in forget: {e}", exc_info=True)
        return {
            "status": "error",
            "message": f"Failed to prune dataset '{dataset_name}': {str(e)}"
        }
