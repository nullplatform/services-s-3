FROM hashicorp/http-echo:1.0.0

CMD ["-text={\"status\":\"ok\",\"msg\":\"Hola mundo\"}", "-listen=:8080", "-status-code=200"]


