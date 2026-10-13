{
  "targets": [
    {
      "target_name": "process_loopback",
      "sources": ["src/process_loopback.cc"],

      "include_dirs": ["<!@(node -p \"require('node-addon-api').include\")"],

      "defines": ["NAPI_VERSION=8"],

      "libraries": [
        "ole32.lib",
        "oleaut32.lib",
        "uuid.lib",
        "mmdevapi.lib"
      ],

      "msvs_settings": {
        "VCCLCompilerTool": {
          "AdditionalOptions": [
            "/std:c++17",
            "/EHsc",
            "/source-charset:utf-8",
            "/execution-charset:utf-8"
          ]
        }
      }
    }
  ]
}
