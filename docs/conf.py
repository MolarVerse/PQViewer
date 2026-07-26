project = "PQViewer"
author = "MolarVerse"
copyright = "2026, MolarVerse"

extensions = [
    "myst_parser",
    "sphinx_design",
]

source_suffix = {
    ".md": "markdown",
}
root_doc = "index"
exclude_patterns = [
    "_build",
]

myst_enable_extensions = [
    "attrs_inline",
    "colon_fence",
    "deflist",
]
myst_heading_anchors = 3

html_theme = "pydata_sphinx_theme"
html_title = "PQViewer documentation"
html_logo = "assets/brand/pq-logo.png"
html_favicon = "assets/brand/pq-logo.png"
html_static_path = ["_static"]
html_css_files = ["custom.css"]
html_context = {
    "default_mode": "auto",
}

html_theme_options = {
    "logo": {
        "text": "PQViewer",
    },
    "github_url": "https://github.com/MolarVerse/PQViewer",
    "navbar_align": "left",
    "navigation_with_keys": True,
    "show_nav_level": 1,
    "show_toc_level": 2,
    "secondary_sidebar_items": ["page-toc"],
    "footer_start": ["copyright"],
    "footer_end": ["sphinx-version"],
}

html_sidebars = {
    "**": ["sidebar-nav-bs.html"],
}
