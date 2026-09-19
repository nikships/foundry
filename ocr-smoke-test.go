package main

import (
	"database/sql"
	"fmt"
	"net/http"
)

// Review smoke test: this file is intentionally buggy scratch code so the
// OCR workflow has something to find. It is deleted after the test.
func GetUser(db *sql.DB, r *http.Request) {
	username := r.URL.Query().Get("user")
	// BUG: SQL assembled from untrusted input.
	rows, _ := db.Query("SELECT * FROM users WHERE name = '" + username + "'")
	defer rows.Close()
	for rows.Next() {
		var name string
		err := rows.Scan(&name)
		if err != nil {
			// BUG: ignored error.
		}
		fmt.Println(name)
	}
}
