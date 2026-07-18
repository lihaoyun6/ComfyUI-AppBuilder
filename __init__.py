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
    
    # 允许动态任意类型的输出
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
    
    # 🔥 现在输出为 BYPASSER 类型，只能连给 Builder 节点的左侧
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
    
    # 使用这个类方法来绕过 ComfyUI 后端的严格类型检查
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


# 1. 限制队列最大长度 420 行。存储格式为 (log_id, log_text) 元组
log_buffer = collections.deque(maxlen=420)
log_counter = 0 # 全局自增日志序列号

class ComfyUIAppViewLogHandler(logging.Handler):
    def emit(self, record):
        global log_counter
        try:
            msg = self.format(record)
            if msg.strip():
                log_counter += 1
                log_buffer.append((log_counter, msg)) # 👈 写入自增 ID 标识
        except Exception:
            self.handleError(record)
            
# 挂载日志记录器
root_logger = logging.getLogger()
i18n_log_handler = ComfyUIAppViewLogHandler()
i18n_log_handler.setFormatter(logging.Formatter("[%(levelname)s] %(message)s"))
root_logger.addHandler(i18n_log_handler)


# 2. 原生输出流包装，专司 tqdm 进度条捕获
class LogStreamWrapper:
    def __init__(self, original_stream):
        self.original_stream = original_stream
        
    def write(self, data):
        global log_counter
        self.original_stream.write(data)
        clean_data = data.strip()
        if clean_data:
            # 过滤普通 INFO 日志避免重复，只捕获进度条
            is_progress = "%|" in clean_data or "it/s" in clean_data or "s/it" in clean_data
            if is_progress:
                log_counter += 1
                log_buffer.append((log_counter, clean_data)) # 👈 写入自增 ID 标识
                
    def flush(self):
        self.original_stream.flush()
        
sys.stdout = LogStreamWrapper(sys.stdout)
sys.stderr = LogStreamWrapper(sys.stderr)


# 3. 👈【终极升级】：支持增量拉取的日志获取路由。实现刷新不丢历史、多端同时共享日志！
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