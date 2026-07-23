import os
import sys
import json
import logging
import collections
import folder_paths

from aiohttp import web
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
    DESCRIPTION = "Generate custom control panel and application view."
    
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

@PromptServer.instance.routes.get("/appbuilder/ls/{folder}")
async def get_models_list(request):
    folder = request.match_info.get("folder")
    if folder in folder_paths.folder_names_and_paths.keys():
        files = folder_paths.get_filename_list(folder)
        return web.json_response(files)
    return web.json_response([], status=404)


# --------------------------------------------------
# 日志处理中心：高速缓存队列
# --------------------------------------------------
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
            
# 挂载标准 Logger 监听
root_logger = logging.getLogger()
log_handler = ComfyUIAppViewLogHandler()
log_handler.setFormatter(logging.Formatter("[%(levelname)s] %(message)s"))
root_logger.addHandler(log_handler)

# --------------------------------------------------
# 标准输出重定向器：专司捕捉进度条 (tqdm)
# --------------------------------------------------
class LogStreamWrapper:
    def __init__(self, original_stream):
        self.original_stream = original_stream
        
    def write(self, data):
        global log_counter
        # 1. 保留原本输出
        self.original_stream.write(data)
        
        # 🔥 核心修改：利用 \r (回车符) 物理特征，100% 降维打击、精准拦截所有进度条碎片！
        is_progress = "\r" in data or "%|" in data or "it/s" in data or "s/it" in data
        
        if is_progress:
            # 去除回车符，提取出干净的进度条文本
            clean_data = data.replace("\r", "").strip()
            if clean_data:
                log_counter += 1
                log_buffer.append((log_counter, clean_data))
                
                # 直接通过 WebSocket 流式推送到前端
                try:
                    PromptServer.instance.send_sync("appbuilder_log", {"id": log_counter, "text": clean_data})
                except Exception:
                    pass
                    
    def flush(self):
        self.original_stream.flush()
        
sys.stdout = LogStreamWrapper(sys.stdout)
sys.stderr = LogStreamWrapper(sys.stderr)


# --------------------------------------------------
# 增量日志 HTTP 获取路由 (保留作为打开网页时的“历史恢复通道”)
# --------------------------------------------------
@PromptServer.instance.routes.get("/appbuilder/logs")
async def get_captured_logs(request):
    try:
        after_id = int(request.query.get("after", 0))
    except ValueError:
        after_id = 0
        
    new_logs = []
    # 过滤出所有大于 after_id 的新行返回给前端
    for log_id, line in log_buffer:
        if log_id > after_id:
            new_logs.append({"id": log_id, "text": line})
            
    return web.json_response(new_logs)

# 解析 ComfyUI 根目录下的 user/default/workflows/app 目录
def get_app_workflows_dir():
    base_dir = os.path.join(folder_paths.get_user_directory(), "default")
    app_dir = os.path.join(base_dir, "workflows", "app")
    if not os.path.exists(app_dir):
        os.makedirs(app_dir, exist_ok=True)
    return app_dir

# 路由 1：获取工作流列表，并输出其名字、大小、修改时间
@PromptServer.instance.routes.get("/appbuilder/workflows")
async def list_app_workflows(request):
    try:
        target_dir = get_app_workflows_dir()
        print(target_dir)
        files = []
        for f in os.listdir(target_dir):
            if f.endswith(".json"):
                full_path = os.path.join(target_dir, f)
                stat = os.stat(full_path)
                files.append({
                    "name": f,
                    "mtime": stat.st_mtime, # 用于前端时间排序
                    "size": stat.st_size
                })
        return web.json_response(files)
    except Exception as e:
        return web.json_response([], status=500)
    
# 路由 2：根据文件名，安全、无损地返回 JSON 树
@PromptServer.instance.routes.get("/appbuilder/workflows/get")
async def get_app_workflow_content(request):
    try:
        filename = request.query.get("file")
        # 基础防跨目录攻击过滤
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
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "AppBuilder": "AppBuilder",
    "AppBuilderBypasser": "AppBuilder Bypasser",
    "AppBuilderAdv": "AppBuilder (Advanced)",
    "ParametersUnpacker": "Parameters Unpacker",
}

WEB_DIRECTORY = "./web"