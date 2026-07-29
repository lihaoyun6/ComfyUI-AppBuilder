import os
import sys
import json
import logging
import collections
import folder_paths
import comfy.sd
import comfy.utils

from aiohttp import web
from nodes import LoraLoader
from server import PromptServer

class AppBuilder:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "config_json": ("STRING", {"default": '{}'}),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
                "prompt": "PROMPT"
            }
        }
    
    RETURN_TYPES = tuple(["*"])
    RETURN_NAMES = tuple(["any"])
    FUNCTION = "main"
    CATEGORY = "AppBuilder"
    
    def main(self, **kwargs):
        return ()

class AppBuilderBypasser:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "group_name": ("STRING", {"default": ""}),
                "bypasser_name": ("STRING", {"default": ""}),
            },
        }
    
    RETURN_TYPES = ("BYPASSER",)
    RETURN_NAMES = ("bypasser",)
    FUNCTION = "main"
    CATEGORY = "AppBuilder"
    DESCRIPTION = "Turn your workflow into an easy-to-use web application."
    
    def main(self, **kwargs):
        return ()

class AppBuilderAdv:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "config_json": ("STRING", {
                    "default": '{"string":{"type": "string","name": "Usage","placeholder": "Click [⚙️ Configuration Panel] button to generate the widgets you need.","multiline":true,"tooltip":"You can delete this sample widget"}}'
                }),
                "live_preview": ("BOOLEAN", {"default": False}),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
                "prompt": "PROMPT"
            }
        }
    
    RETURN_TYPES = ("parameters",)
    RETURN_NAMES = ("parameters",)
    FUNCTION = "execute"
    CATEGORY = "AppBuilder"
    DESCRIPTION = "Turn your workflow into an easy-to-use web application."
    
    @classmethod
    def VALIDATE_INPUTS(cls, **kwargs):
        return True
    
    def execute(self, config_json, unique_id=None, prompt=None, **kwargs):
        try:
            config = json.loads(config_json)
            keys = list(config.keys())[:32]
            
            results = {}
            raw_inputs = {}
            if prompt is not None and unique_id is not None:
                node_info = prompt.get(str(unique_id), {})
                raw_inputs = node_info.get("inputs", {})
                
            for key in keys:
                params = config[key]
                val = raw_inputs.get(key, kwargs.get(key, params.get("default", None)))
                expected_type = params.get("type", "STRING").upper()
                precision = params.get("precision", None)
                
                if val is not None:
                    try:
                        if expected_type == "INT": val = int(round(float(val)))
                        elif expected_type == "FLOAT":
                            val = float(val)
                            if precision is not None: val = round(val, int(precision))
                        elif expected_type == "BOOLEAN": val = bool(val)
                    except: pass
                results[key] = val
                
            bundle = {
                "data": results,
                "config": {k: config[k] for k in keys}
            }
            return (bundle,)
        except Exception:
            raise

class ParametersUnpacker:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "parameters": ("parameters",),
            }
        }
    
    RETURN_TYPES = tuple(["*"] * 32)
    RETURN_NAMES = tuple(["*"] * 32)
    FUNCTION = "unpack"
    CATEGORY = "AppBuilder"
    
    def unpack(self, parameters=None):
        try:
            data = parameters["data"]
            config = parameters["config"]
            
            results = []
            for key in config.keys():
                results.append(data.get(key, None))
            
            return tuple(results)
        except Exception:
            raise

class AppBuilderLoraStack:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "lora_stack": ("STRING", {"default": '[{"lora_name":"None","strength":1.0,"enabled":true}]'}),
            },
            "optional": {
                "model": ("MODEL",),
                "clip": ("CLIP",),
            }
        }
    
    RETURN_TYPES = ("MODEL", "CLIP")
    RETURN_NAMES = ("MODEL", "CLIP")
    FUNCTION = "apply_lora_stack"
    CATEGORY = "AppBuilder"
    
    def apply_lora_stack(self, lora_stack, model=None, clip=None):
        try:
            loras = json.loads(lora_stack)
        except Exception:
            loras = []
            
        if not isinstance(loras, list):
            loras = []
            
        current_model = model
        current_clip = clip
        
        lora_loader = LoraLoader()
        
        for lora_info in loras:
            if not isinstance(lora_info, dict):
                continue
            
            # 1. 过滤未开启的 Lora
            if not lora_info.get("enabled", True):
                continue
            
            lora_name = lora_info.get("lora_name")
            if not lora_name or lora_name == "None":
                continue
            
            # 2. 提取强度 (学习 rgthree：支持 Model 强度与 CLIP 强度解耦)
            strength_model = float(lora_info.get("strength", 1.0))
            # 如果前端没传 strength_clip，默认使用与 strength_model 相同的值
            strength_clip = float(lora_info.get("strength_clip", strength_model))
            
            # 如果强度全部为 0，跳过融合以节省算力
            if strength_model == 0 and strength_clip == 0:
                continue
            
            # 3. 校验文件是否存在
            lora_path = folder_paths.get_full_path("loras", lora_name)
            if not lora_path:
                print(f"[AppBuilderLoraStack] Warning: LoRA file '{lora_name}' not found!")
                continue
            
            # 4. 调用官方 LoraLoader 执行安全融合
            try:
                if current_model is not None or current_clip is not None:
                    current_model, current_clip = lora_loader.load_lora(
                        current_model, 
                        current_clip, 
                        lora_name, 
                        strength_model, 
                        strength_clip
                    )
            except Exception as e:
                print(f"[AppBuilderLoraStack] Error loading LoRA '{lora_name}': {e}")
                
        return (current_model, current_clip)
    
@PromptServer.instance.routes.get("/appbuilder/ls/{folder}")
async def get_models_list(request):
    folder = request.match_info.get("folder")
    if folder in folder_paths.folder_names_and_paths.keys():
        files = folder_paths.get_filename_list(folder)
        return web.json_response(files)
    return web.json_response([], status=404)

log_buffer = collections.deque(maxlen=420)
log_counter = 0 

class ComfyUIAppViewLogHandler(logging.Handler):
    def emit(self, record):
        global log_counter
        try:
            msg = self.format(record)
            if msg.strip():
                log_counter += 1
                log_buffer.append((log_counter, msg)) 
                try:
                    PromptServer.instance.send_sync("appbuilder_log", {"id": log_counter, "text": msg})
                except Exception:
                    pass
        except Exception:
            self.handleError(record)
            
root_logger = logging.getLogger()
log_handler = ComfyUIAppViewLogHandler()
log_handler.setFormatter(logging.Formatter("[%(levelname)s] %(message)s"))
root_logger.addHandler(log_handler)

class LogStreamWrapper:
    def __init__(self, original_stream):
        self.original_stream = original_stream
        
    def write(self, data):
        global log_counter
        self.original_stream.write(data)
        is_progress = "\r" in data or "%|" in data or "it/s" in data or "s/it" in data
        if is_progress:
            clean_data = data.replace("\r", "").strip()
            if clean_data:
                log_counter += 1
                log_buffer.append((log_counter, clean_data))
                try:
                    PromptServer.instance.send_sync("appbuilder_log", {"id": log_counter, "text": clean_data})
                except Exception:
                    pass
                    
    def flush(self):
        self.original_stream.flush()
        
sys.stdout = LogStreamWrapper(sys.stdout)
sys.stderr = LogStreamWrapper(sys.stderr)

@PromptServer.instance.routes.get("/appbuilder/logs")
async def get_captured_logs(request):
    try:
        after_id = int(request.query.get("after", 0))
    except ValueError:
        after_id = 0
        
    new_logs = []
    for log_id, line in log_buffer:
        if log_id > after_id:
            new_logs.append({"id": log_id, "text": line})
            
    return web.json_response(new_logs)

def get_app_workflows_dir():
    base_dir = os.path.join(folder_paths.get_user_directory(), "default")
    app_dir = os.path.join(base_dir, "workflows", "app")
    if not os.path.exists(app_dir):
        os.makedirs(app_dir, exist_ok=True)
    return app_dir

@PromptServer.instance.routes.get("/appbuilder/workflows")
async def list_app_workflows(request):
    try:
        target_dir = get_app_workflows_dir()
        files = []
        for f in os.listdir(target_dir):
            if f.endswith(".json"):
                full_path = os.path.join(target_dir, f)
                stat = os.stat(full_path)
                files.append({
                    "name": f,
                    "mtime": stat.st_mtime, 
                    "size": stat.st_size
                })
        return web.json_response(files)
    except Exception as e:
        return web.json_response([], status=500)
    
@PromptServer.instance.routes.get("/appbuilder/workflows/get")
async def get_app_workflow_content(request):
    try:
        filename = request.query.get("file")
        if not filename or ".." in filename or "/" in filename or "\\" in filename:
            return web.json_response({"error": "Invalid filename"}, status=400)
        
        target_dir = get_app_workflows_dir()
        full_path = os.path.join(target_dir, filename)
        
        if os.path.exists(full_path):
            with open(full_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            return web.json_response(data)
        return web.json_response({"error": "File not found"}, status=404)
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)

NODE_CLASS_MAPPINGS = {
    "AppBuilder": AppBuilder,
    "AppBuilderBypasser": AppBuilderBypasser,
    "AppBuilderAdv": AppBuilderAdv,
    "ParametersUnpacker": ParametersUnpacker,
    "AppBuilderLoraStack": AppBuilderLoraStack,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "AppBuilder": "AppBuilder",
    "AppBuilderBypasser": "AppBuilder Bypasser",
    "AppBuilderAdv": "AppBuilder (Advanced)",
    "ParametersUnpacker": "Parameters Unpacker",
    "AppBuilderLoraStack": "AppBuilder Lora Stack",
}

WEB_DIRECTORY = "./web"