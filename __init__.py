import os
import sys
import json
import logging
import hashlib
import traceback
import collections

import nodes
import folder_paths
import comfy.model_management

from aiohttp import web
from nodes import LoraLoader
from server import PromptServer
from comfy_api.internal import _ComfyNodeInternal

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
                logging.warning(f"[AppBuilderLoraStack] Warning: LoRA file '{lora_name}' not found!")
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
                logging.error(f"[AppBuilderLoraStack] Error loading LoRA '{lora_name}': {e}")
                
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

@PromptServer.instance.routes.post("/appbuilder/workflows/save")
async def save_app_workflow(request):
    try:
        data = await request.json()
        filename = data.get("filename")
        content = data.get("content")
        
        if not filename or not content:
            return web.json_response({"error": "Missing filename or content"}, status=400)
            
        target_path = os.path.join(get_app_workflows_dir(), filename)
        
        with open(target_path, "w", encoding="utf-8") as f:
            if isinstance(content, dict):
                json.dump(content, f, indent=2, ensure_ascii=False)
            else:
                f.write(str(content))
                
        return web.json_response({"status": "success", "filename": filename})
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)
    
IGNORE = {'.git', '__pycache__', 'node_modules', '.venv', 'venv'}
EXTS = {'.py', '.safetensors', '.ckpt', '.pt', '.bin', '.pth', '.onnx', '.sft'}

def scan_dir(path, file_list):
    try:
        for entry in os.scandir(path):
            name = entry.name
            if name.startswith('.') or name in IGNORE:
                continue
            try:
                if entry.is_dir(follow_symlinks=False):
                    scan_dir(entry.path, file_list)
                else:
                    ext = os.path.splitext(name)[1].lower()
                    if ext in EXTS:
                        stat = entry.stat(follow_symlinks=False)
                        file_list.append(f"{entry.path}_{stat.st_mtime_ns}_{stat.st_size}")
            except OSError:
                continue
    except OSError:
        pass
        
_BOOT_SIGNATURE = str(os.getpid())

def get_nodes_environment_hash():
    """检测模型和节点的物理更新 (mtime & size)"""
    hasher = hashlib.md5()
    hasher.update(_BOOT_SIGNATURE.encode())
    file_list = []
    
    try:
        custom_node_paths = folder_paths.get_folder_paths("custom_nodes")
    except Exception:
        custom_node_paths = []
        
    for custom_dir in custom_node_paths:
        if os.path.isdir(custom_dir):
            scan_dir(custom_dir, file_list)
            
    visited_dirs = set()
    for type_name, paths_tuple in folder_paths.folder_names_and_paths.items():
        for base_path in paths_tuple[0]:
            if not os.path.isdir(base_path):
                continue
            for root, dirs, _ in os.walk(base_path, followlinks=True):
                real_root = os.path.realpath(root)
                if real_root in visited_dirs:
                    dirs[:] = []
                    continue
                visited_dirs.add(real_root)
                try:
                    stat = os.stat(root)
                    file_list.append(f"dir_{root}_{stat.st_mtime_ns}")
                except OSError:
                    pass
                    
    for item in sorted(file_list):
        hasher.update(item.encode())
        
    return hasher.hexdigest()

def safe_get_node_info(node_class):
    # 2. 完整移植官方 node_info 逻辑 (支持 V1 节点协议、中文名、描述气泡等)
    try:
        if hasattr(nodes, "NODE_CLASS_MAPPINGS") and node_class in nodes.NODE_CLASS_MAPPINGS:
            obj_class = nodes.NODE_CLASS_MAPPINGS[node_class]
            
            # 支持 ComfyUI 内部 V1 节点新协议
            if issubclass(obj_class, _ComfyNodeInternal):
                return obj_class.GET_NODE_INFO_V1()
            
            info = {}
            info['input'] = obj_class.INPUT_TYPES()
            info['input_order'] = {key: list(value.keys()) for (key, value) in obj_class.INPUT_TYPES().items()}
            info['is_input_list'] = getattr(obj_class, "INPUT_IS_LIST", False)
            info['output'] = obj_class.RETURN_TYPES
            info['output_is_list'] = getattr(obj_class, "OUTPUT_IS_LIST", [False] * len(obj_class.RETURN_TYPES))
            info['output_name'] = getattr(obj_class, "RETURN_NAMES", info['output'])
            info['name'] = node_class
            info['display_name'] = nodes.NODE_DISPLAY_NAME_MAPPINGS.get(node_class, node_class)
            info['description'] = getattr(obj_class, "DESCRIPTION", "")
            info['python_module'] = getattr(obj_class, "RELATIVE_PYTHON_MODULE", "nodes")
            info['category'] = getattr(obj_class, "CATEGORY", "sd")
            info['output_node'] = getattr(obj_class, "OUTPUT_NODE", False)
            info['has_intermediate_output'] = getattr(obj_class, "HAS_INTERMEDIATE_OUTPUT", False)
            info['output_tooltips'] = getattr(obj_class, "OUTPUT_TOOLTIPS", None)
            info['deprecated'] = getattr(obj_class, "DEPRECATED", False)
            info['experimental'] = getattr(obj_class, "EXPERIMENTAL", False)
            info['dev_only'] = getattr(obj_class, "DEV_ONLY", False)
            
            if hasattr(obj_class, 'API_NODE'):
                info['api_node'] = obj_class.API_NODE
                
            info['search_aliases'] = getattr(obj_class, 'SEARCH_ALIASES', [])
            
            if hasattr(obj_class, 'ESSENTIALS_CATEGORY'):
                info['essentials_category'] = obj_class.ESSENTIALS_CATEGORY
                
            return info
    except Exception as e:
        logging.warning(f"[AppBuilder] Failed to get full node_info for '{node_class}': {e}")
        
    return None

# ===== 内存智能缓存变量 =====
_GLOBAL_OBJECT_INFO_CACHE = None
_GLOBAL_ENV_HASH = None

def get_cached_object_info():
    global _GLOBAL_OBJECT_INFO_CACHE, _GLOBAL_ENV_HASH
    
    current_hash = get_nodes_environment_hash()
    
    # 如果强刷、未缓存、缓存长度为 0、或 Hash 变动，强制刷新
    if _GLOBAL_OBJECT_INFO_CACHE is None or len(_GLOBAL_OBJECT_INFO_CACHE) == 0 or current_hash != _GLOBAL_ENV_HASH:
        try:
            if hasattr(nodes, "asset_seeder") and hasattr(nodes.asset_seeder, "start"):
                nodes.asset_seeder.start(roots=("models", "input", "output"))
        except Exception:
            pass
            
        out = {}
        if hasattr(nodes, "NODE_CLASS_MAPPINGS"):
            for x in list(nodes.NODE_CLASS_MAPPINGS.keys()):
                info = safe_get_node_info(x)
                if info:
                    out[x] = info
                    
        if len(out) > 0:
            _GLOBAL_OBJECT_INFO_CACHE = out
            _GLOBAL_ENV_HASH = current_hash
            #logging.info(f"[AppBuilder] Object Info Cache Updated! {len(out)} nodes loaded successfully. (Hash: {current_hash[:8]})")
        else:
            logging.error("[AppBuilder] Warning: NODE_CLASS_MAPPINGS is empty or failed to load!")
            
    return _GLOBAL_OBJECT_INFO_CACHE or {}, _GLOBAL_ENV_HASH

# ===== 🚀 智能按需 + 自动感知的 API 路由 =====
@PromptServer.instance.routes.get("/appbuilder/fast_object_info")
async def get_fast_object_info_smart(request):
    try:
        app_file = request.query.get("app")
        
        # 1. 智能获取全局最新信息 (若无变动直接返回 0ms 内存缓存)
        all_info, env_hash = get_cached_object_info()

        # 2. 如果指定了 app 配置文件，做“按需过滤” (15MB 降到 ~10KB)
        if app_file:
            clean_filename = os.path.basename(app_file)
            if not clean_filename.endswith(".json"):
                clean_filename += ".json"
            app_path = os.path.join(get_app_workflows_dir(), clean_filename)

            if os.path.exists(app_path):
                with open(app_path, "r", encoding="utf-8") as f:
                    wf_data = json.load(f)
                    used_types = set(n.get("type") for n in wf_data.get("nodes", []) if n.get("type"))
                    filtered_info = {k: v for k, v in all_info.items() if k in used_types}

                    response = web.json_response(filtered_info)
                    response.headers['ETag'] = f'"{env_hash}"'
                    response.headers['Cache-Control'] = 'no-cache'
                    return response
                
        # 3. 兜底返回完整数据
        response = web.json_response(all_info)
        response.headers['ETag'] = f'"{env_hash}"'
        response.headers['Cache-Control'] = 'no-cache'
        return response
    except Exception as e:
        logging.error(f"[AppBuilder] fast_object_info error: {e}")
        return web.json_response({"error": str(e)}, status=500)

@PromptServer.instance.routes.get("/appbuilder/system_stats")
async def system_stats(request):
    # 1. 内存 RAM (ComfyUI 原生)
    cpu_device = comfy.model_management.torch.device("cpu")
    ram_total = comfy.model_management.get_total_memory(cpu_device)
    ram_free = comfy.model_management.get_free_memory(cpu_device)
    ram_used = max(0, ram_total - ram_free)
    ram_utilization = round((ram_used / ram_total) * 100, 1) if ram_total > 0 else 0
    
    # 2. NVIDIA GPU 核心用量与显存 VRAM (PyTorch 原生)
    primary_device = comfy.model_management.get_torch_device()
    torch_devices = comfy.model_management.get_all_torch_devices()
    if primary_device in torch_devices:
        torch_devices = [primary_device] + [d for d in torch_devices if d != primary_device]
    else:
        torch_devices = [primary_device] + list(torch_devices)
        
    torch_lib = comfy.model_management.torch
    device_entries = []
    
    for d in torch_devices:
        if d.type != "cuda":
            continue  # 只读取 NVIDIA 设备
        
        vram_total, _ = comfy.model_management.get_total_memory(d, torch_total_too=True)
        vram_free, _ = comfy.model_management.get_free_memory(d, torch_free_too=True)
        vram_used = max(0, vram_total - vram_free)
        vram_utilization = round((vram_used / vram_total) * 100, 1) if vram_total > 0 else 0
        
        gpu_utilization = 0
        if torch_lib.cuda.is_available():
            try:
                idx = d.index if d.index is not None else 0
                gpu_utilization = torch_lib.cuda.utilization(idx)
            except Exception:
                gpu_utilization = 0
                
        device_entries.append({
            "name": comfy.model_management.get_torch_device_name(d),
            "type": d.type,
            "index": d.index,
            "gpu_utilization": gpu_utilization,
            "vram_total": vram_total,
            "vram_free": vram_free,
            "vram_used": vram_used,
            "vram_utilization": vram_utilization
        })
        
    return web.json_response({
        "system": {
            "ram_total": ram_total,
            "ram_free": ram_free,
            "ram_used": ram_used,
            "ram_utilization": ram_utilization
        },
        "devices": device_entries
    })

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
CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))

@PromptServer.instance.routes.get("/apps")
async def serve_app_manager(request):
    html_path = os.path.join(CURRENT_DIR, "web", "app_manager.html")
    if os.path.exists(html_path):
        return web.FileResponse(html_path)
    return web.Response(status=404, text="app_manager.html not found")

@PromptServer.instance.routes.get("/app_view.html")
async def serve_app_view(request):
    html_path = os.path.join(CURRENT_DIR, "web", "app_view.html")
    if os.path.exists(html_path):
        return web.FileResponse(html_path)
    return web.Response(status=404, text="app_view.html not found")

@PromptServer.instance.routes.get("/i18n/{filename}")
async def serve_i18n_files(request):
    filename = request.match_info['filename']
    json_path = os.path.join(CURRENT_DIR, "web", "i18n", filename)
    if os.path.exists(json_path):
        return web.FileResponse(json_path, headers={"Cache-Control": "no-cache"})
    return web.Response(status=404, text=f"'i18n/{filename}' not found")