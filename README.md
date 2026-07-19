# Bashkir Haiku Contest

Static archive of a Bashkir-language haiku contest held in February 2024.

[Open the archive](https://bashkirhaiku.anatoliy.ch/) · [Read the final post](https://t.me/ch_an/1902)

![Bashkir Haiku Contest illustration](html/img/og_image.webp)

Participants submitted original three-line haiku in Bashkir through a Telegram discussion. Each person could enter up to five poems. Three jury members selected three different winners, with physical prizes for the winning entries.

The website preserves the rules, jury and contributor credits, Telegram discussion widget, and final post from the completed contest.

## Repository

The archive is a single static HTML page served by nginx in Docker Compose. It uses Bootstrap and Telegram's native post and discussion widgets.

For a quick local preview:

```sh
python3 -m http.server 8000 --directory html
```

Then open <http://localhost:8000>.
