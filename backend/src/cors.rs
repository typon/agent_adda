use rocket::fairing::{Fairing, Info, Kind};
use rocket::{Request, Response};

pub struct Cors;

#[rocket::async_trait]
impl Fairing for Cors {
    fn info(&self) -> Info {
        Info {
            name: "Agent Adda CORS",
            kind: Kind::Response,
        }
    }

    async fn on_response<'r>(&self, _request: &'r Request<'_>, response: &mut Response<'r>) {
        response.set_raw_header("Access-Control-Allow-Origin", "*");
        response.set_raw_header(
            "Access-Control-Allow-Methods",
            "GET, POST, PATCH, DELETE, OPTIONS",
        );
        response.set_raw_header(
            "Access-Control-Allow-Headers",
            "Content-Type, Authorization",
        );
    }
}
